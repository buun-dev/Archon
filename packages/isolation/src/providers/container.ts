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
  getHomeScriptsPath,
  getProjectRoot,
  resolveRepoProjectIdentity,
  toNodeVisiblePath,
} from '@archon/paths';

import { dockerPreflight } from '../container/docker-exec';
import {
  SANDBOX_HOST_DEFAULTS,
  SandboxLifecycle,
  defaultSandboxDocker,
  defaultWslRunner,
  resolveSandboxHost,
  shq,
  type RepoSandboxConfig,
  type ResolvedSandboxHost,
  type SandboxHostConfig,
  type WslRunner,
} from '../backends/sandbox';
import type {
  ExecutionContext,
  WriteBackApplySummary,
  WriteBackFinalizeResult,
} from '@archon/providers/types';

import type {
  ContainerEnvironment,
  DestroyResult,
  IIsolationProvider,
  IsolatedEnvironment,
  IsolationRequest,
  RepoConfigLoader,
  WorktreeCreateConfig,
  WorktreeDestroyOptions,
} from '../types';
import { isPRIsolationRequest } from '../types';

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
/** The preflight's whole budget is seconds — it must never look like provisioning. */
const WSL_PROBE_TIMEOUT_MS = 20 * 1000;

interface ExecResult {
  stdout: string;
  stderr: string;
}
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
 * Deliberately separate from `assertSupported`, which judges the REQUEST (a
 * `--from` start point, a PR checkout) rather than the environment.
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
      `build the runner image \`${host.image}\` (this fork builds it with ~/.archon/sandbox/build-runner.sh), ` +
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

export class ContainerProvider implements IIsolationProvider {
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

  async create(request: IsolationRequest): Promise<IsolatedEnvironment> {
    // Reject before provisioning: the sandbox cuts only from the base branch, so an
    // explicit --from or a PR checkout would go green against the WRONG tree.
    this.assertSupported(request);
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

    // Worktree-in-distro + compose up + provision. No port allocator — the
    // container owns its own 3000/8123/5432 in a private network namespace.
    await this.lifecycle.up({
      distro: host.distro,
      project,
      repo,
      slug,
      baseBranch,
      baseClone: `${host.repoRoot}/${repo}`,
      worktree: workingPath,
      image: host.image,
      composeBase: toNodeVisiblePath(SANDBOX_COMPOSE_FILE),
      composeOverlay: repoSandbox.compose ? `${workingPath}/${repoSandbox.compose}` : undefined,
      provision: repoSandbox.provision,
      scriptsDir: toNodeVisiblePath(getHomeScriptsPath()),
      metaDir: toNodeVisiblePath(projectRootFor(request)),
      gitIdentity: request.gitIdentity ?? host.gitIdentity,
      secrets: pick(this.secretsFrom, ['GH_TOKEN', 'ANTHROPIC_API_KEY']),
    });

    const containerId = await this.resolveContainerId(project);
    return this.buildEnv(slug, workingPath, project, containerId, request, baseBranch);
  }

  /**
   * Reattach to an existing sandbox on RESUME (D8 recovery). The container may be
   * STOPPED after a kill or a docker restart — resolveContainerId `start`s the
   * agent before resolving — so this rebuilds the container execContext from the
   * working path WITHOUT re-running the lifecycle (no re-provision). Throws if
   * the stack is gone (torn down); a resume then cannot continue in-container.
   */
  async reattach(workingPath: string): Promise<ContainerEnvironment> {
    const { repo, slug } = repoSlugFromWorkingPath(workingPath);
    const project = composeProjectFor(repo, slug);
    const containerId = await this.resolveContainerId(project);
    return this.buildEnv(slug, workingPath, project, containerId);
  }

  /**
   * Engine-facing container-run port (structural `ContainerWriteBackBackend`,
   * Phase C). The executor's resume guard requires a `container` context for any
   * run stamped `isolation: 'container'`; this is the repo-kind implementation.
   * The working path is bound here at construction; the `envId` each closure
   * receives is the engine's `isolation_environments` row id (D5) and is unused
   * — the compose stack is addressed by the bound path, not by that id. A
   * repo-kind sandbox writes straight to its git worktree branch — there is no
   * overlay diff to gate — so `finalize` never requests approval, which makes
   * `applyChanges`/`discardChanges` unreachable (defensive rejects). `suspend`
   * genuinely stops the agent service (pause economics); `reattach()`'s
   * resolveContainerId `start`s it again on the next resume. Deliberately NOT
   * the folder ContainerBackend: no prepare/resumeEnv/destroy, so the CLI's
   * folder teardown paths (which would tear the worktree down) cannot engage.
   */
  writeBackBackend(workingPath: string): {
    suspend(envId: string): Promise<void>;
    finalize(envId: string): Promise<WriteBackFinalizeResult>;
    applyChanges(envId: string): Promise<WriteBackApplySummary>;
    discardChanges(envId: string): Promise<void>;
  } {
    const project = composeProjectFromWorkingPath(workingPath);
    return {
      // The engine hands us its `isolation_environments` row id here (D5). The
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
   * Best-effort teardown (mirrors WorktreeProvider.destroy's contract): composes
   * the stack down `-v` and removes the worktree + `sandbox/<slug>` branch in the
   * distro. Every step is best-effort inside the lifecycle — the run is already
   * over — and a machine whose distro cannot be reached at all is logged, not thrown.
   */
  async destroy(envId: string, _options?: WorktreeDestroyOptions): Promise<DestroyResult> {
    const { repo, slug } = repoSlugFromWorkingPath(envId);
    const host = await this.host().catch(() => undefined);
    if (host) {
      await this.lifecycle.down({
        distro: host.distro,
        project: composeProjectFor(repo, slug),
        slug,
        baseClone: `${host.repoRoot}/${repo}`,
        worktree: envId,
      });
    }
    return {
      worktreeRemoved: true,
      branchDeleted: null,
      remoteBranchDeleted: null,
      directoryClean: true,
      warnings: [],
    };
  }

  async get(envId: string): Promise<IsolatedEnvironment | null> {
    const { repo, slug } = repoSlugFromWorkingPath(envId);
    const project = composeProjectFor(repo, slug);
    if (!(await this.composeAgentRunning(project))) return null;
    const containerId = await this.resolveContainerId(project);
    return this.buildEnv(slug, envId, project, containerId);
  }

  async list(codebaseId: string): Promise<IsolatedEnvironment[]> {
    // codebaseId is the canonical repo path; its basename names the repo. Compose
    // projects are `archon-<repo>-<slug>`, so the `archon-<repo>-` prefix scopes
    // the listing to this repo's envs, never leaking another's.
    const repo = basename(codebaseId);
    const prefix = `archon-${repo}-`;
    let stdout = '[]';
    try {
      ({ stdout } = await this.docker(['compose', 'ls', '--all', '--format', 'json'], {
        timeout: DOCKER_QUERY_TIMEOUT_MS,
      }));
    } catch {
      return [];
    }
    let entries: { Name?: string }[] = [];
    try {
      entries = JSON.parse(stdout || '[]') as { Name?: string }[];
    } catch {
      return [];
    }
    const envs: IsolatedEnvironment[] = [];
    let worktreeRoot: string | undefined;
    for (const entry of entries) {
      const name = entry.Name ?? '';
      if (!name.startsWith(prefix)) continue;
      const slug = name.slice(prefix.length);
      const containerId = await this.resolveContainerId(name).catch(() => '');
      if (!containerId) continue;
      worktreeRoot ??= (await this.host()).worktreeRoot;
      envs.push(this.buildEnv(slug, `${worktreeRoot}/${repo}/${slug}`, name, containerId));
    }
    return envs;
  }

  async healthCheck(envId: string): Promise<boolean> {
    const { repo, slug } = repoSlugFromWorkingPath(envId);
    return this.composeAgentRunning(composeProjectFor(repo, slug));
  }

  /** Reject requests the sandbox cannot honor (PR checkout, explicit --from). */
  private assertSupported(request: IsolationRequest): void {
    if (isPRIsolationRequest(request)) {
      throw new Error(
        'Container isolation cannot check out a PR: the sandbox cuts a fresh branch off ' +
          'the base branch. Use worktree isolation for PR workflows.'
      );
    }
    // `--from` now rides on the task's branch selection (upstream's TaskBranchSelection),
    // so the same refusal reads it there. `kind: 'existing'` is a different request —
    // continuing a branch, not cutting from a start point — and is not refused here.
    const taskFromBranch =
      request.workflowType === 'task' && request.taskBranch?.kind === 'new'
        ? request.taskBranch.fromBranch
        : undefined;
    if (taskFromBranch) {
      throw new Error(
        `Container isolation cannot cut from an explicit start point (--from ${taskFromBranch}): ` +
          'the sandbox cuts only from the base branch.'
      );
    }
  }

  /**
   * The repo's `isolation` section, checked where it becomes a decision — the
   * loader is fail-soft and cannot refuse. `provision` is required: Archon runs
   * exactly one command in the fresh container (D1), and a repo that names none
   * would hand every node an unprovisioned worktree that fails on its first
   * `uv run`, far from the setting that caused it.
   */
  private async requireRepoSandboxConfig(
    repoPath: string
  ): Promise<RepoSandboxConfig & { provision: string }> {
    let config: RepoSandboxConfig | null;
    try {
      config = await this.loadRepoSandboxConfig(repoPath);
    } catch (err) {
      throw new Error(`Failed to load config: ${(err as Error).message}`);
    }
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
   * The machine, for the methods that address an existing stack (`destroy`,
   * `list`) and so never ran the preflight: one probe for the distro home, cached.
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
   * Resolve the compose `agent` service to a concrete container id (2a). `start`
   * first so a resume after a docker restart re-runs the stopped service; harmless
   * on a fresh `up`. Fails loud when nothing resolves — a silent '' would build a
   * broken execContext that only surfaces at the first node exec.
   */
  private async resolveContainerId(project: string): Promise<string> {
    await this.docker(['compose', '-p', project, 'start', 'agent'], {
      timeout: DOCKER_QUERY_TIMEOUT_MS,
    }).catch(() => undefined);
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

  /** `docker compose -p <project> ps` → is the `agent` service running? */
  private async composeAgentRunning(project: string): Promise<boolean> {
    try {
      const { stdout } = await this.docker(
        ['compose', '-p', project, 'ps', '--status', 'running', '--format', 'json'],
        { timeout: DOCKER_QUERY_TIMEOUT_MS }
      );
      return /"Service"\s*:\s*"agent"/.test(stdout);
    } catch {
      return false;
    }
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
      metadata: { adopted: false, ...(request ? { request } : {}) },
    };
  }

  /**
   * Slug = the WorktreeProvider branch name with the `archon/` org-prefix stripped
   * and any remaining `/` flattened to `-`, so it is one filesystem-safe path
   * segment + compose-project suffix. Mirrors the worktree branch-name rule so
   * ledger linkage stays consistent across providers.
   */
  private slugFor(request: IsolationRequest): string {
    return this.generateBranchName(request)
      .replace(/^archon\//, '')
      .replace(/\//g, '-');
  }

  // --- Branch-name helpers, byte-identical to WorktreeProvider's slug derivation. ---

  generateBranchName(request: IsolationRequest): string {
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
        return `archon/task-${this.slugify(request.identifier)}`;
    }
  }

  private shortHash(input: string): string {
    return createHash('sha256').update(input).digest('hex').substring(0, 8);
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }
}

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
 * The run's project dir — `~/.archon/workspaces/<owner>/<repo>` — as the engine
 * resolves it for artifacts and logs. Mounted at its own (distro-visible) path so
 * `$ARTIFACTS_DIR` means one thing on both sides.
 */
function projectRootFor(request: IsolationRequest): string {
  const identity = resolveRepoProjectIdentity(
    request.codebaseName ?? '',
    request.canonicalRepoPath
  ) ?? { owner: '_local', repo: basename(request.canonicalRepoPath) };
  return getProjectRoot(identity.owner, identity.repo);
}
