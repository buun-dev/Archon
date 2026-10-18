/**
 * Container Provider — WSL-sandbox container isolation for repo-kind projects.
 *
 * Re-expressed behind upstream's `ExecutionContext` contract (Phase 1). Instead
 * of `git worktree add` on the host, this provider drives the `SandboxLifecycle`
 * (`backends/sandbox.ts`): a worktree cut in the WSL distro, a compose stack made
 * of Archon's base file plus the repo's overlay, the repo's one provisioning
 * command, then the firewall. The engine stays on Windows; the Windows `docker`
 * CLI drives the Linux daemon natively, so `docker compose …` state queries run
 * WITHOUT wsl.exe. Only the commands that touch the distro filesystem — git, the
 * handshake file, and `compose up` with its bind mounts — go through `wsl.exe`.
 *
 * create() resolves the compose `agent` service to a concrete container id and
 * returns a container `ExecutionContext` (containerId + execUser) — the worktree
 * and the run meta dir are bind-mounted at their host paths, so there is no
 * second name to carry. Matches upstream's `ExecutionContext` shape exactly, so
 * its `runSubprocess`/`buildContainerSpawn` drive node execution unchanged. We
 * deliberately do NOT adopt the folder
 * `ContainerBackend`/overlay/write-back — this is an execution substrate for a
 * git worktree, not a folder review-buffer.
 *
 * Addressing: compose project `archon-<repo>-<slug>`, service `agent`,
 * in-container workdir set per run to the worktree's distro path (compose's
 * `working_dir`, bind-mounted at that same path on both sides).
 *
 * What the machine looks like — the distro, the runner image, where the base
 * clones and worktrees live, a fallback git identity — is the global config's
 * `isolation.container` section, with defaults for the original layout. What the
 * repo needs — its compose overlay and its provisioning command — is the repo's
 * `isolation` section. Both are injected as loaders, like `worktree.baseBranch`.
 */

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';

import { execFileAsync, toBranchName, getDefaultBranch, toRepoPath } from '@archon/git';
import {
  createLogger,
  getHomeScriptsPath,
  getProjectStoragePaths,
  resolveProjectStorageKey,
  toNodeVisiblePath,
} from '@archon/paths';
import type { ExecutionContext } from '@archon/provider-contract';
import type {
  ContainerWriteBackBackend,
  WriteBackApplySummary,
  WriteBackFinalizeResult,
} from '@archon/workflows/container-context';

import { dockerPreflight, extractDockerError } from '../container/docker-exec';
import {
  SANDBOX_HOST_DEFAULTS,
  SandboxLifecycle,
  defaultSandboxDocker,
  defaultWslRunner,
  resolveSandboxHost,
  shq,
  type ExecResult,
  type RepoSandboxConfig,
  type ResolvedSandboxHost,
  type SandboxHostConfig,
  type WslRunner,
} from '../backends/sandbox';

import type {
  ContainerEnvironment,
  DestroyResult,
  IContainerIsolationProvider,
  IsolationRequest,
  RepoConfigLoader,
  SandboxInspection,
  TaskIsolationRequest,
  WorktreeCreateConfig,
} from '../types';

const log = createLogger('isolation.container');

/** Container runs as uid 1000 (compose `user: "1000:1000"`); `docker exec` must match. */
const CONTAINER_EXEC_USER = '1000';

/**
 * Archon's half of the compose recipe, beside the runner Dockerfile. The firewall
 * script and the allowlist it mounts live in the same directory — compose resolves
 * their `./` paths against this file's, which is why it is always passed first.
 */
export const SANDBOX_COMPOSE_FILE = join(
  import.meta.dir,
  '..',
  '..',
  'docker',
  'sandbox.compose.yml'
);

const DOCKER_QUERY_TIMEOUT_MS = 30 * 1000;
/** `compose stop` waits for each container's stop grace period (10 s default). */
const COMPOSE_STOP_TIMEOUT_MS = 2 * 60 * 1000;

/** The preflight's whole budget is seconds — it must never look like provisioning. */
const WSL_PROBE_TIMEOUT_MS = 20 * 1000;

type DockerRunner = (args: string[], opts: { timeout: number }) => Promise<ExecResult>;
/** Runs one `bash -c <script>` inside a WSL distro. Used only by the preflight. */
type WslProbe = (distro: string, script: string, timeoutMs: number) => Promise<ExecResult>;
/** Loads the global `isolation.container` section; `null` when nothing is configured. */
export type SandboxHostConfigLoader = () => Promise<SandboxHostConfig | null>;
/** Loads a repo's `isolation` section (`compose`, `provision`); `null` when absent. */
export type RepoSandboxConfigLoader = (repoPath: string) => Promise<RepoSandboxConfig | null>;

/**
 * THE compose-project naming rule — one definition, deliberately exported.
 * Each stack comes up as `archon-<repo>-<slug>`, and BOTH segments are
 * load-bearing (two repos can carry the same slug). Anything that addresses a
 * live stack (`docker compose -p … exec agent`) must derive the name through here.
 */
export function composeProjectFor(repo: string, slug: string): string {
  return `archon-${repo}-${slug}`;
}

/** Same rule, derived from a working path `<worktree-root>/<repo>/<slug>`. */
export function composeProjectFromWorkingPath(workingPath: string): string {
  const { repo, slug } = repoSlugFromWorkingPath(workingPath);
  return composeProjectFor(repo, slug);
}

/** Last path segment, tolerating POSIX and Windows separators + trailing slash. */
function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** Split a working path `<base>/<repo>/<slug>` into its repo and slug segments. */
function repoSlugFromWorkingPath(envId: string): { repo: string; slug: string } {
  const parts = envId
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter(Boolean);
  return { slug: parts[parts.length - 1] ?? '', repo: parts[parts.length - 2] ?? '' };
}

/** Default docker runner — the Windows docker CLI drives the Linux daemon natively. */
function defaultDocker(args: string[], opts: { timeout: number }): Promise<ExecResult> {
  return execFileAsync('docker', args, opts);
}

/**
 * Default WSL probe — one `bash -c` in the distro. `--exec`, never `--`: `--`
 * routes the command line through the distro's login shell, which expands `$HOME`
 * in the script before bash sees it (harmless here, wrong in general) and is slow.
 */
function defaultProbeWsl(distro: string, script: string, timeoutMs: number): Promise<ExecResult> {
  return execFileAsync('wsl.exe', ['-d', distro, '--exec', 'bash', '-c', script], {
    timeout: timeoutMs,
  });
}

/**
 * Markers the probe script echoes. Reading OUR OWN tokens out of stdout is what
 * keeps this off the `classifyIsolationError` prose-matching path: a wsl.exe or
 * bash rewording cannot change which prerequisite we name. `ARCHON_WSL_OK` is
 * unconditional, so its presence means the distro answered; `ARCHON_WSL_HOME=`
 * carries the distro home the default roots resolve against; `ARCHON_BASE_CLONE_OK`
 * is gated on the repo's base clone. One round trip answers all three.
 */
const WSL_MARKER = 'ARCHON_WSL_OK';
const WSL_HOME_MARKER = 'ARCHON_WSL_HOME=';
const BASE_CLONE_MARKER = 'ARCHON_BASE_CLONE_OK';

/** `if` returns 0 on a false condition, so the probe always exits 0 when the distro is up. */
function prerequisiteProbe(baseClone: string): string {
  // `~` is expanded by bash here — the probe is the one place the distro home is
  // not yet known, so the unresolved config value is handed to the shell that knows.
  const clone = baseClone.startsWith('~/') ? `"$HOME"${shq(baseClone.slice(1))}` : shq(baseClone);
  return (
    `echo ${WSL_MARKER}; echo "${WSL_HOME_MARKER}$HOME"; ` +
    `if [ -d ${clone}/.git ]; then echo ${BASE_CLONE_MARKER}; fi`
  );
}

/**
 * Named in every refusal. The done-when is "names the setting the operator must
 * correct", and for every prerequisite that setting is the same one.
 */
const PROVIDER_SETTING_HINT =
  'This repo asks for container isolation (`isolation.provider: container` in ' +
  '.archon/config.yaml); set it to `worktree` to run on the host instead.';

/**
 * Why the WSL probe failed, in as few words as are actually informative.
 *
 * Not `extractDockerError`: when `wsl.exe` refuses a distro it writes UTF-16LE that
 * reaches us as an EMPTY `stderr`, and the fallback — `err.message` — is
 * `Command failed: wsl.exe -d Ubuntu … <the whole probe script>`, which buries the
 * actionable sentence under an echo of our own command. Verified live 2026-09-10
 * against a non-existent distro. So: a real stderr line if there is one, else the
 * errno (`ENOENT` when wsl.exe is absent, `ETIMEDOUT` on a hung distro), else nothing.
 */
function probeFailureDetail(err: unknown): string {
  const e = err as Error & { stderr?: string; code?: string | number };
  const stderr = (e.stderr ?? '').trim();
  if (stderr) return ` (${stderr.split('\n')[0]})`;
  return e.code ? ` (${String(e.code)})` : '';
}

/**
 * Refuse a request the sandbox cannot honor: a PR checkout, an explicit `--from`
 * start point, or a named or existing task branch. The sandbox always cuts a fresh
 * `sandbox/<slug>` branch from the base, so any of these would go green against the
 * wrong tree.
 *
 * The one owner of the request check: `ContainerProvider.create` calls it before it
 * provisions, and the CLI calls it before it writes a run row, with only the part of
 * the request it knows by then.
 */
export function assertContainerRequestSupported(
  request: Pick<IsolationRequest, 'workflowType'> & Pick<TaskIsolationRequest, 'taskBranch'>
): void {
  if (request.workflowType === 'pr') {
    throw new Error(
      'Container isolation cannot check out a PR: the sandbox cuts a fresh branch off ' +
        'the base branch. Use worktree isolation for PR workflows.'
    );
  }
  if (request.workflowType !== 'task' || !request.taskBranch) return;
  // `--from` rides on the task's branch selection (upstream's TaskBranchSelection),
  // so the same refusal reads it there.
  const { taskBranch } = request;
  if (taskBranch.kind === 'new' && taskBranch.fromBranch) {
    throw new Error(
      `Container isolation cannot cut from an explicit start point (--from ${taskBranch.fromBranch}): ` +
        'the sandbox cuts only from the base branch.'
    );
  }
  // Continuing an existing branch, or naming the new one, would otherwise be ignored:
  // the run would go green on a fresh `sandbox/<slug>` branch instead.
  if (taskBranch.branch) {
    throw new Error(
      `Container isolation cannot check out an existing or named branch ('${taskBranch.branch}'): ` +
        'repo-kind container isolation cuts a fresh `sandbox/<slug>` branch from the base ' +
        'branch. Run this without container isolation. ' +
        PROVIDER_SETTING_HINT
    );
  }
}

/**
 * The repo's `isolation` section, checked where it becomes a decision — the loader is
 * fail-soft and cannot refuse. `provision` is required: Archon runs exactly one command
 * in the fresh container, and a repo that names none would hand every node an
 * unprovisioned worktree that fails on its first `uv run`, far from the setting that
 * caused it. Returns the section trimmed, with an empty `compose` dropped.
 *
 * The one owner of that check: `ContainerProvider.create` calls it on the section its
 * loader returns, and the CLI calls it on the repo config it reads before the run row.
 */
export function assertRepoSandboxConfigComplete(
  config: RepoSandboxConfig | null
): RepoSandboxConfig & { provision: string } {
  const provision = config?.provision?.trim();
  if (!provision) {
    throw new Error(
      'Container isolation needs the repo to say how to provision its worktree: set ' +
        '`isolation.provision` in .archon/config.yaml to the one command Archon runs inside ' +
        'the fresh container (for example `python3 scripts/sandbox_env.py`). ' +
        PROVIDER_SETTING_HINT
    );
  }
  const compose = config?.compose?.trim();
  return { ...(compose ? { compose } : {}), provision };
}

export interface ContainerPrerequisiteDeps {
  /** WSL probe runner (tests inject a fake; prod shells `wsl.exe -d <distro>`). */
  probeWsl?: WslProbe;
  /** Docker CLI runner (tests inject a fake; prod runs the Windows `docker` CLI). */
  docker?: DockerRunner;
  /** The machine's `isolation.container` config; defaults apply for anything unset. */
  host?: SandboxHostConfig | null;
}

/** What the preflight learned, for the create that follows it. */
export interface ContainerPrerequisites {
  host: ResolvedSandboxHost;
}

/**
 * Fail a container dispatch BEFORE anything is created when a prerequisite that
 * lives outside the repo is absent (#2206: "Unsupported or incomplete
 * configuration fails before a run starts and names the setting the operator
 * must correct").
 *
 * Five prerequisites, two probes and a stat: one `bash -c` in the distro answers
 * the distro and the repo's base clone (and reports the distro home), the base
 * compose file is Archon's own asset and is stat'd on the host, and
 * `dockerPreflight` — the folder backend's existing preflight, reused rather than
 * reimplemented — answers the daemon and the runner image. Present prerequisites
 * cost about a second; provisioning budgets twenty minutes.
 *
 * Deliberately separate from {@link assertContainerRequestSupported}, which judges
 * the REQUEST (a `--from` start point, a PR checkout) rather than the environment.
 */
export async function assertContainerPrerequisites(
  repo: string,
  deps: ContainerPrerequisiteDeps = {}
): Promise<ContainerPrerequisites> {
  const probe = deps.probeWsl ?? defaultProbeWsl;
  const docker = deps.docker ?? defaultDocker;
  const configured = deps.host ?? undefined;
  const distro = configured?.distro ?? SANDBOX_HOST_DEFAULTS.distro;
  // Unresolved on purpose: `~` is expanded by the probe, inside the distro.
  const baseClone = `${configured?.repoRoot ?? SANDBOX_HOST_DEFAULTS.repoRoot}/${repo}`;

  let stdout: string;
  try {
    ({ stdout } = await probe(distro, prerequisiteProbe(baseClone), WSL_PROBE_TIMEOUT_MS));
  } catch (err) {
    throw new Error(
      `Container isolation is unavailable: the WSL distro '${distro}' is not reachable` +
        `${probeFailureDetail(err)}. Install or start it (\`wsl --install -d ${distro}\`), ` +
        'or name the right one in ~/.archon/config.yaml `isolation.container.distro`. ' +
        PROVIDER_SETTING_HINT
    );
  }
  if (!stdout.includes(WSL_MARKER)) {
    throw new Error(
      `Container isolation is unavailable: the WSL distro '${distro}' answered nothing. ` +
        `Check it with \`wsl -d ${distro} -- true\`. ` +
        PROVIDER_SETTING_HINT
    );
  }
  const home = stdout
    .split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith(WSL_HOME_MARKER))
    ?.slice(WSL_HOME_MARKER.length);
  if (!home) {
    throw new Error(
      `Container isolation is unavailable: the WSL distro '${distro}' reported no $HOME, ` +
        'so the sandbox paths cannot be resolved. ' +
        PROVIDER_SETTING_HINT
    );
  }
  const host = resolveSandboxHost(configured, home);
  if (!stdout.includes(BASE_CLONE_MARKER)) {
    throw new Error(
      `Container isolation is unavailable: no base clone of '${repo}' at ` +
        `${host.repoRoot}/${repo} inside the ${distro} distro. Clone it there ` +
        `(\`wsl -d ${distro} -- git clone <url> ${host.repoRoot}/${repo}\`), or point ` +
        '~/.archon/config.yaml `isolation.container.repoRoot` at where the clones live. ' +
        PROVIDER_SETTING_HINT
    );
  }

  if (!existsSync(SANDBOX_COMPOSE_FILE)) {
    throw new Error(
      "Container isolation is unavailable: Archon's base compose file is missing at " +
        `${SANDBOX_COMPOSE_FILE}. This is a broken Archon checkout, not a repo or machine ` +
        'setting; restore packages/isolation/docker/. ' +
        PROVIDER_SETTING_HINT
    );
  }

  try {
    await dockerPreflight(
      host.image,
      (args, options) => docker(args, { timeout: options?.timeout ?? DOCKER_QUERY_TIMEOUT_MS }),
      `build the runner image \`${host.image}\` with ~/.archon/sandbox/build-runner.sh, ` +
        'or name an existing image in ~/.archon/config.yaml `isolation.container.image`'
    );
  } catch (err) {
    throw new Error(
      `Container isolation is unavailable: ${(err as Error).message} ${PROVIDER_SETTING_HINT}`
    );
  }
  return { host };
}

export interface ContainerProviderDeps {
  /** Repo config loader (for `worktree.baseBranch`). Defaults to a no-op loader. */
  loadConfig?: RepoConfigLoader;
  /** Repo `isolation` section loader (`compose`, `provision`). Defaults to a no-op loader. */
  loadRepoSandboxConfig?: RepoSandboxConfigLoader;
  /** Global `isolation.container` loader. Defaults to a no-op loader (all defaults). */
  loadHostConfig?: SandboxHostConfigLoader;
  /** Distro script runner for the lifecycle (tests inject a fake; prod shells `wsl.exe --exec`). */
  wsl?: WslRunner;
  /** Docker CLI runner (tests inject a fake; prod runs the Windows `docker` CLI). */
  docker?: DockerRunner;
  /** WSL probe runner for the prerequisite preflight (tests inject a fake). */
  probeWsl?: WslProbe;
  /** Where the lifecycle's transcript goes. Defaults to stdout as `[container] …` lines. */
  onLine?: (line: string) => void;
  /** Where `GH_TOKEN` / `ANTHROPIC_API_KEY` are read from. Defaults to `process.env`. */
  secretsFrom?: NodeJS.ProcessEnv;
}

export class ContainerProvider implements IContainerIsolationProvider {
  readonly providerType = 'container' as const;

  private readonly loadConfig: RepoConfigLoader;
  private readonly loadRepoSandboxConfig: RepoSandboxConfigLoader;
  private readonly loadHostConfig: SandboxHostConfigLoader;
  private readonly docker: DockerRunner;
  private readonly probeWsl: WslProbe;
  private readonly lifecycle: SandboxLifecycle;
  private readonly secretsFrom: NodeJS.ProcessEnv;
  /** The machine, resolved once per provider: the distro is asked for `$HOME` at most once. */
  private hostPromise: Promise<ResolvedSandboxHost> | undefined;

  constructor(deps: ContainerProviderDeps = {}) {
    this.loadConfig =
      deps.loadConfig ?? ((): Promise<WorktreeCreateConfig | null> => Promise.resolve(null));
    this.loadRepoSandboxConfig =
      deps.loadRepoSandboxConfig ??
      ((): Promise<RepoSandboxConfig | null> => Promise.resolve(null));
    this.loadHostConfig =
      deps.loadHostConfig ?? ((): Promise<SandboxHostConfig | null> => Promise.resolve(null));
    this.docker = deps.docker ?? defaultDocker;
    this.probeWsl = deps.probeWsl ?? defaultProbeWsl;
    this.secretsFrom = deps.secretsFrom ?? process.env;
    this.lifecycle = new SandboxLifecycle({
      wsl: deps.wsl ?? defaultWslRunner,
      docker: (args, opts): Promise<ExecResult> =>
        deps.docker
          ? deps.docker(args, { timeout: opts.timeoutMs })
          : defaultSandboxDocker(args, opts),
      onLine:
        deps.onLine ??
        ((line): void => {
          console.log(`[container] ${line}`);
        }),
    });
  }

  async create(request: IsolationRequest): Promise<ContainerEnvironment> {
    // Reject before provisioning: the sandbox cuts only from the base branch, so an
    // explicit --from, a named or existing branch, or a PR checkout would go green
    // against the WRONG tree.
    assertContainerRequestSupported(request);
    const repo = basename(request.canonicalRepoPath);
    // Then the repo's own declaration, which costs a config read and no subprocess.
    const repoSandbox = await this.requireRepoSandboxConfig(request.canonicalRepoPath);
    // Then the ENVIRONMENT. The request is judged first because a malformed
    // request is wrong on any machine; the probes cost a round trip.
    const { host } = await assertContainerPrerequisites(repo, {
      probeWsl: this.probeWsl,
      docker: this.docker,
      host: await this.loadHostConfig(),
    });
    this.hostPromise = Promise.resolve(host);

    const slug = this.slugFor(request);
    const workingPath = `${host.worktreeRoot}/${repo}/${slug}`;
    const project = composeProjectFor(repo, slug);
    // The worktree lives in the distro, so the branch has to cross the wsl.exe
    // boundary as an argument; auto-detection runs against the host checkout.
    const baseBranch = await this.resolveBaseBranch(request);

    const baseClone = `${host.repoRoot}/${repo}`;
    // Worktree-in-distro + compose up + provision. No port allocator — the
    // container owns its own 3000/8123/5432 in a private network namespace. `up`
    // refuses a slug another run's sandbox holds, and tears down what it made if it
    // fails after cutting the worktree.
    await this.lifecycle.up({
      distro: host.distro,
      project,
      repo,
      slug,
      baseBranch,
      baseClone,
      worktree: workingPath,
      image: host.image,
      composeBase: toNodeVisiblePath(SANDBOX_COMPOSE_FILE),
      composeOverlay: repoSandbox.compose ? `${workingPath}/${repoSandbox.compose}` : undefined,
      provision: repoSandbox.provision,
      scriptsDir: toNodeVisiblePath(getHomeScriptsPath()),
      metaDir: toNodeVisiblePath(projectRootFor(request, workingPath)),
      // The machine's identity for the worktree. A run whose initiating user is
      // known authors its commits through `GIT_AUTHOR_*` in the run env (#3746).
      gitIdentity: host.gitIdentity,
      secrets: pick(this.secretsFrom, ['GH_TOKEN', 'ANTHROPIC_API_KEY']),
    });

    let containerId: string;
    try {
      containerId = await this.resolveContainerId(project);
    } catch (err) {
      // `up` succeeded, so this call made the stack and the worktree, and no row names
      // them yet: tear them down before the caller sees the error.
      log.warn(
        { project, err: err instanceof Error ? err.message : String(err) },
        'container.create.rolling_back'
      );
      await this.lifecycle
        .down({ distro: host.distro, project, slug, baseClone, worktree: workingPath })
        .catch((rollbackErr: unknown) => {
          log.error(
            {
              project,
              err: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            },
            'container.create.rollback_failed'
          );
        });
      throw err;
    }
    return this.buildEnv(slug, workingPath, project, containerId, request, baseBranch);
  }

  /**
   * Reattach to an existing sandbox on RESUME. The container may be
   * STOPPED after a pause, a terminal run, a kill or a docker restart —
   * resolveContainerId `start`s the stack before resolving — so this rebuilds the
   * container execContext from the working path WITHOUT re-running the lifecycle
   * (no re-provision). A start gives the agent a fresh network namespace, so the
   * firewall is applied again before the context is handed back; if it fails, the
   * stack is stopped again (best-effort) and the reattach throws, so no resume runs
   * with open egress. Throws if the stack is gone (torn down); a resume then cannot
   * continue in-container.
   */
  async reattach(workingPath: string): Promise<ContainerEnvironment> {
    const { repo, slug } = repoSlugFromWorkingPath(workingPath);
    const project = composeProjectFor(repo, slug);
    const containerId = await this.resolveContainerId(project);
    try {
      await this.lifecycle.applyFirewall(project);
    } catch (firewallErr) {
      await this.docker(['compose', '-p', project, 'stop'], {
        timeout: COMPOSE_STOP_TIMEOUT_MS,
      }).catch((stopErr: unknown) => {
        log.warn(
          { project, err: stopErr instanceof Error ? stopErr.message : String(stopErr) },
          'container.reattach.stop_after_firewall_failure_failed'
        );
      });
      throw firewallErr;
    }
    return this.buildEnv(slug, workingPath, project, containerId);
  }

  /**
   * Engine-facing container-run port (`ContainerWriteBackBackend`, Phase C).
   * The executor's resume guard requires a `container` context for any
   * run stamped `isolation: 'container'`; this is the repo-kind implementation.
   * The working path is bound here at construction; the `envId` each closure
   * receives is the engine's `isolation_environments` row id and is unused
   * — the compose stack is addressed by the bound path, not by that id. A
   * repo-kind sandbox writes straight to its git worktree branch — there is no
   * overlay diff to gate — so `finalize` never requests approval, which makes
   * `applyChanges`/`discardChanges` unreachable (defensive rejects). `suspend`
   * genuinely stops the agent service (pause economics); `reattach()`'s
   * resolveContainerId `start`s it again on the next resume. Deliberately NOT
   * the folder ContainerBackend: no prepare/resumeEnv/destroy, so the CLI's
   * folder teardown paths (which would tear the worktree down) cannot engage.
   */
  writeBackBackend(workingPath: string): ContainerWriteBackBackend {
    const project = composeProjectFromWorkingPath(workingPath);
    return {
      // The engine hands us its `isolation_environments` row id here. The
      // compose stack is addressed by the path bound above, so the id is unused.
      suspend: async (): Promise<void> => {
        await this.docker(['compose', '-p', project, 'stop', 'agent'], {
          timeout: DOCKER_QUERY_TIMEOUT_MS,
        });
      },
      finalize: (): Promise<WriteBackFinalizeResult> =>
        Promise.resolve({ requiresApproval: false }),
      applyChanges: (): Promise<WriteBackApplySummary> =>
        Promise.reject(
          new Error(
            'Repo-kind container isolation has no overlay write-back: changes are already ' +
              'commits on the sandbox worktree branch.'
          )
        ),
      discardChanges: (): Promise<void> =>
        Promise.reject(
          new Error(
            'Repo-kind container isolation has no overlay write-back to discard: changes ' +
              'are already commits on the sandbox worktree branch.'
          )
        ),
    };
  }

  /**
   * Stop every service of a run's stack: the agent AND whatever the repo's
   * overlay declares. A terminal run frees its RAM this way and keeps its
   * worktree, branch, volumes and row; `reattach` starts the stack again.
   * Throws on a docker failure — the CLI surfaces a stack it could not stop.
   */
  async stop(workingPath: string): Promise<void> {
    const project = composeProjectFromWorkingPath(workingPath);
    await this.docker(['compose', '-p', project, 'stop'], { timeout: COMPOSE_STOP_TIMEOUT_MS });
  }

  /**
   * The reap's evidence for one sandbox. Throws on any probe that
   * cannot answer — an unreadable compose listing, a worktree probe without its
   * markers — so the caller holds the row rather than reading silence as "gone".
   */
  async inspect(workingPath: string): Promise<SandboxInspection> {
    const { repo, slug } = repoSlugFromWorkingPath(workingPath);
    const stackExists = await this.lifecycle.composeProjectExists(composeProjectFor(repo, slug));
    const host = await this.host();
    const wt = await this.lifecycle.inspectWorktree(host.distro, workingPath);
    return { stackExists, worktreeExists: wt.exists, dirty: wt.dirty, unpushed: wt.unpushed };
  }

  /**
   * Best-effort teardown (mirrors WorktreeProvider.destroy's contract): composes
   * the stack down `-v` and removes the worktree + `sandbox/<slug>` branch in the
   * distro. Every step is best-effort inside the lifecycle — the run is already
   * over. A machine whose distro cannot be reached at all is logged, not thrown,
   * and the result says nothing was torn down.
   */
  async destroy(workingPath: string): Promise<DestroyResult> {
    const { repo, slug } = repoSlugFromWorkingPath(workingPath);
    let host: ResolvedSandboxHost;
    try {
      host = await this.host();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ workingPath, err: message }, 'container.destroy.host_unreachable');
      return {
        worktreeRemoved: false,
        branchDeleted: null,
        remoteBranchDeleted: null,
        directoryClean: false,
        warnings: [
          `WSL distro unreachable: ${message}; the sandbox stack and worktree were not torn down`,
        ],
      };
    }
    await this.lifecycle.down({
      distro: host.distro,
      project: composeProjectFor(repo, slug),
      slug,
      baseClone: `${host.repoRoot}/${repo}`,
      worktree: workingPath,
    });
    return {
      worktreeRemoved: true,
      branchDeleted: null,
      remoteBranchDeleted: null,
      directoryClean: true,
      warnings: [],
    };
  }

  /** The repo's `isolation` section, loaded and checked by {@link assertRepoSandboxConfigComplete}. */
  private async requireRepoSandboxConfig(
    repoPath: string
  ): Promise<RepoSandboxConfig & { provision: string }> {
    let config: RepoSandboxConfig | null;
    try {
      config = await this.loadRepoSandboxConfig(repoPath);
    } catch (err) {
      throw new Error(`Failed to load config: ${(err as Error).message}`);
    }
    return assertRepoSandboxConfigComplete(config);
  }

  /**
   * Base precedence: a per-dispatch --base override wins, then repo config, then
   * the registered codebase default, then git auto-detect — identical to
   * WorktreeProvider so a --base X container run cuts (and targets) the same base.
   */
  private async resolveBaseBranch(request: IsolationRequest): Promise<string> {
    let config: WorktreeCreateConfig | null;
    try {
      config = await this.loadConfig(request.canonicalRepoPath);
    } catch (err) {
      throw new Error(`Failed to load config: ${(err as Error).message}`);
    }
    const preferred = request.baseOverride ?? config?.baseBranch ?? request.baseBranch;
    if (preferred) return preferred;
    return getDefaultBranch(toRepoPath(request.canonicalRepoPath));
  }

  /**
   * The machine, for the methods that address an existing stack (`inspect`,
   * `destroy`) and so never ran the preflight: one probe for the distro home, cached.
   */
  private host(): Promise<ResolvedSandboxHost> {
    this.hostPromise ??= (async (): Promise<ResolvedSandboxHost> => {
      const configured = (await this.loadHostConfig()) ?? undefined;
      const distro = configured?.distro ?? SANDBOX_HOST_DEFAULTS.distro;
      const { stdout } = await this.probeWsl(
        distro,
        `echo "${WSL_HOME_MARKER}$HOME"`,
        WSL_PROBE_TIMEOUT_MS
      );
      const home = stdout
        .split('\n')
        .map(l => l.trim())
        .find(l => l.startsWith(WSL_HOME_MARKER))
        ?.slice(WSL_HOME_MARKER.length);
      if (!home) throw new Error(`The WSL distro '${distro}' reported no $HOME.`);
      return resolveSandboxHost(configured, home);
    })();
    return this.hostPromise;
  }

  /**
   * Resolve the compose `agent` service to a concrete container id. `start`
   * first — every service, since a terminal run's `stop` stops the repo's
   * services as well as the agent — so a resume after a stop or a docker restart
   * re-runs what is stopped; harmless on a fresh `up`. A start that fails fails
   * here, carrying docker's own error: a stack that would not start cannot host the
   * run. Fails loud when nothing resolves — a silent '' would build a broken
   * execContext that only surfaces at the first node exec.
   */
  private async resolveContainerId(project: string): Promise<string> {
    try {
      await this.docker(['compose', '-p', project, 'start'], {
        timeout: DOCKER_QUERY_TIMEOUT_MS,
      });
    } catch (err) {
      throw new Error(
        `Could not start the sandbox stack '${project}': ${extractDockerError(err)}`,
        { cause: err }
      );
    }
    const { stdout } = await this.docker(['compose', '-p', project, 'ps', '-q', 'agent'], {
      timeout: DOCKER_QUERY_TIMEOUT_MS,
    });
    const id = stdout.trim().split('\n')[0]?.trim() ?? '';
    if (!id) {
      throw new Error(
        `Could not resolve a container id for compose project '${project}' (service 'agent'). ` +
          'Is the sandbox stack up?'
      );
    }
    return id;
  }

  /** Assemble the ContainerEnvironment for a slug/workingPath/containerId. */
  private buildEnv(
    slug: string,
    workingPath: string,
    project: string,
    containerId: string,
    request?: IsolationRequest,
    baseBranch?: string
  ): ContainerEnvironment {
    // The worktree and the run meta dir are bind-mounted at their host paths, so a
    // path means one thing on either side of the boundary and there is nothing to
    // remap. Matches upstream's container context exactly.
    const execContext: Extract<ExecutionContext, { kind: 'container' }> = {
      kind: 'container',
      containerId,
      execUser: CONTAINER_EXEC_USER,
    };
    return {
      id: workingPath,
      provider: 'container',
      workingPath,
      project,
      execContext,
      // The lifecycle creates the branch as `sandbox/<slug>` off the base clone.
      branchName: toBranchName(`sandbox/${slug}`),
      ...(baseBranch ? { baseBranch: toBranchName(baseBranch) } : {}),
      status: 'active',
      createdAt: new Date(),
      metadata: request ? { request } : {},
    };
  }

  /**
   * Slug = the WorktreeProvider branch name with the `archon/` org-prefix stripped
   * and any remaining `/` flattened to `-`, so it is one filesystem-safe path
   * segment + compose-project suffix. Mirrors the worktree branch-name rule so
   * ledger linkage stays consistent across providers. A `task` slug that would
   * exceed 50 characters is truncated and keeps a hash of the full identifier, so
   * two identifiers that differ only in the cut-off tail (the CLI appends
   * `Date.now()`) never share a slug.
   */
  private slugFor(request: IsolationRequest): string {
    return this.generateBranchName(request)
      .replace(/^archon\//, '')
      .replace(/\//g, '-');
  }

  // --- Branch-name helpers: WorktreeProvider's derived names. Its explicit `taskBranch`
  // names never reach here: `assertContainerRequestSupported` refuses a request that
  // carries one. ---

  private generateBranchName(request: IsolationRequest): string {
    switch (request.workflowType) {
      case 'issue':
        return `archon/issue-${request.identifier}`;
      case 'pr':
        if (!request.isForkPR) return request.prBranch;
        return `archon/pr-${request.identifier}-review`;
      case 'review':
        return `archon/review-${request.identifier}`;
      case 'thread':
        return `archon/thread-${this.shortHash(request.identifier)}`;
      case 'task':
        return `archon/task-${this.taskSlug(request.identifier)}`;
    }
  }

  private shortHash(input: string): string {
    return createHash('sha256').update(input).digest('hex').substring(0, 8);
  }

  private taskSlug(identifier: string): string {
    const slug = this.slugify(identifier);
    if (slug.length <= TASK_SLUG_MAX) return slug;
    const head = slug.substring(0, TASK_SLUG_MAX - 9).replace(/-$/, '');
    return `${head}-${this.shortHash(identifier)}`;
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}

/** Longest task slug, hash suffix included. */
const TASK_SLUG_MAX = 50;

/** The named keys that are set, and nothing else — the lifecycle sees no other secret. */
function pick<K extends string>(source: NodeJS.ProcessEnv, keys: K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = source[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The run's project storage root — artifacts, logs, state and frozen source all live
 * under it — derived through the engine's own owner (`resolveProjectStorageKey`, then
 * `getProjectStoragePaths`) for this repo-kind codebase and the run's working path, so
 * the mount is exactly where the engine reads and writes, fallbacks included. Mounted at
 * its own (distro-visible) path so `$ARTIFACTS_DIR` means one thing on both sides.
 */
function projectRootFor(request: IsolationRequest, workingPath: string): string {
  const codebase = {
    kind: 'repo',
    name: request.codebaseName ?? '',
    default_cwd: request.canonicalRepoPath,
  };
  return getProjectStoragePaths(resolveProjectStorageKey(codebase, workingPath)).root;
}
