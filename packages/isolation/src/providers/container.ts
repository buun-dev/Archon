/**
 * Container Provider — WSL-sandbox container isolation for repo-kind projects.
 *
 * Re-expressed behind upstream's `ExecutionContext` contract (Phase 1). Instead
 * of `git worktree add`, this provider shells the already-validated `sandbox.sh`
 * lifecycle (`up` = worktree-in-distro + compose up + provision; `down` = compose
 * down + worktree remove). The engine stays on Windows; the Windows `docker` CLI
 * drives the Linux daemon natively, so `docker compose …` state queries run
 * WITHOUT wsl.exe. Only the git-provisioning script (`sandbox.sh`, which lives in
 * the distro FS) is invoked through `wsl.exe`.
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
 * Addressing (from `compose.yml.tmpl`): compose project `archon-<repo>-<slug>`,
 * service `agent`, in-container workdir set per run to the worktree's host path
 * (compose's `working_dir`, bind-mounted at that same path on both sides).
 */

import { createHash } from 'crypto';

import { execFileAsync, toBranchName, getDefaultBranch, toRepoPath } from '@archon/git';
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

/**
 * Real, LF-safe path to the lifecycle script. Never a `/tmp` copy — the script
 * self-locates via `${BASH_SOURCE[0]}`, so a copy breaks its `SANDBOX_DIR`.
 */
const SANDBOX_SH = '/mnt/c/Users/Buun/.archon/sandbox/sandbox.sh';
/** Base dir under which sandbox.sh places each repo's worktrees, one subdir per repo. */
const WORKTREE_ROOT_BASE = '/home/bunny/archon/worktrees';
/** Container runs as uid 1000 (compose `user: "1000:1000"`); `docker exec` must match. */
const CONTAINER_EXEC_USER = '1000';

/** `sandbox.sh up` provisions (uv sync + install + alembic + playwright); be generous. */
const SANDBOX_UP_TIMEOUT_MS = 20 * 60 * 1000;
const SANDBOX_DOWN_TIMEOUT_MS = 5 * 60 * 1000;
const DOCKER_QUERY_TIMEOUT_MS = 30 * 1000;

interface ExecResult {
  stdout: string;
  stderr: string;
}
type SandboxRunner = (
  args: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>
) => Promise<ExecResult>;
type DockerRunner = (args: string[], opts: { timeout: number }) => Promise<ExecResult>;

/**
 * THE compose-project naming rule — one definition, deliberately exported.
 * `sandbox.sh` brings each stack up as `archon-<repo>-<slug>`, and BOTH segments
 * are load-bearing (two repos can carry the same slug). Anything that addresses a
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

/** Default WSL runner — invokes `sandbox.sh` inside the Ubuntu distro. */
function defaultRunSandbox(
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {}
): Promise<ExecResult> {
  // wsl.exe forwards only WSLENV-named vars into the distro. Forward the secrets
  // `sandbox.sh` bakes into the container via envsubst (GH_TOKEN, ANTHROPIC_API_KEY)
  // plus any identity vars. `/u` = Windows → WSL only.
  const forwarded = ['GH_TOKEN', 'ANTHROPIC_API_KEY', ...Object.keys(extraEnv)];
  const wslenv = [process.env.WSLENV, ...forwarded.map(name => `${name}/u`)]
    .filter(Boolean)
    .join(':');
  return execFileAsync('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', SANDBOX_SH, ...args], {
    timeout: timeoutMs,
    env: { ...process.env, ...extraEnv, WSLENV: wslenv },
  });
}

/** Default docker runner — the Windows docker CLI drives the Linux daemon natively. */
function defaultDocker(args: string[], opts: { timeout: number }): Promise<ExecResult> {
  return execFileAsync('docker', args, opts);
}

/**
 * The originating user's git identity, as env for `sandbox.sh`. This provider
 * cannot `git config` the worktree (it's a distro path Windows git can't reach),
 * so `sandbox.sh` stamps it where the filesystem is. Empty when absent (solo
 * installs), leaving the script's own fallback identity in force.
 */
function identityEnv(request: IsolationRequest): Record<string, string> {
  const identity = request.gitIdentity;
  if (!identity?.email) return {};
  return {
    ARCHON_GIT_USER_EMAIL: identity.email,
    ...(identity.name ? { ARCHON_GIT_USER_NAME: identity.name } : {}),
  };
}

export interface ContainerProviderDeps {
  /** Repo config loader (for `worktree.baseBranch`). Defaults to a no-op loader. */
  loadConfig?: RepoConfigLoader;
  /** WSL sandbox runner (tests inject a fake; prod shells `sandbox.sh` via wsl.exe). */
  runSandbox?: SandboxRunner;
  /** Docker CLI runner (tests inject a fake; prod runs the Windows `docker` CLI). */
  docker?: DockerRunner;
}

export class ContainerProvider implements IIsolationProvider {
  readonly providerType = 'container' as const;

  private readonly loadConfig: RepoConfigLoader;
  private readonly runSandbox: SandboxRunner;
  private readonly docker: DockerRunner;

  constructor(deps: ContainerProviderDeps = {}) {
    this.loadConfig =
      deps.loadConfig ?? ((): Promise<WorktreeCreateConfig | null> => Promise.resolve(null));
    this.runSandbox = deps.runSandbox ?? defaultRunSandbox;
    this.docker = deps.docker ?? defaultDocker;
  }

  async create(request: IsolationRequest): Promise<IsolatedEnvironment> {
    // Reject before provisioning: `sandbox.sh up` cuts only from the base branch,
    // so an explicit --from or a PR checkout would go green against the WRONG tree.
    this.assertSupported(request);

    const repo = basename(request.canonicalRepoPath);
    const slug = this.slugFor(request);
    const workingPath = `${WORKTREE_ROOT_BASE}/${repo}/${slug}`;
    const project = composeProjectFor(repo, slug);
    // The worktree lives in the distro, so the branch has to cross the wsl.exe
    // boundary as an argument; auto-detection runs against the host checkout.
    const baseBranch = await this.resolveBaseBranch(request);

    // Worktree-in-distro + compose up + provision. No port allocator — the
    // container owns its own 3000/8123/5432 in a private network namespace.
    await this.runSandbox(
      ['up', repo, slug, baseBranch],
      SANDBOX_UP_TIMEOUT_MS,
      identityEnv(request)
    );

    const containerId = await this.resolveContainerId(project);
    return this.buildEnv(slug, workingPath, project, containerId, request, baseBranch);
  }

  /**
   * Reattach to an existing sandbox on RESUME (D8 recovery). The container may be
   * STOPPED after a kill or a docker restart — resolveContainerId `start`s the
   * agent before resolving — so this rebuilds the container execContext from the
   * working path WITHOUT re-running `sandbox.sh up` (no re-provision). Throws if
   * the stack is gone (torn down); a resume then cannot continue in-container.
   */
  async reattach(envId: string): Promise<ContainerEnvironment> {
    const { repo, slug } = repoSlugFromWorkingPath(envId);
    const project = composeProjectFor(repo, slug);
    const containerId = await this.resolveContainerId(project);
    return this.buildEnv(slug, envId, project, containerId);
  }

  /**
   * Engine-facing container-run port (structural `ContainerWriteBackBackend`,
   * Phase C). The executor's resume guard requires a `container` context for any
   * run stamped `isolation: 'container'`; this is the repo-kind implementation.
   * A repo-kind sandbox writes straight to its git worktree branch — there is no
   * overlay diff to gate — so `finalize` never requests approval, which makes
   * `applyChanges`/`discardChanges` unreachable (defensive rejects). `suspend`
   * genuinely stops the agent service (pause economics); `reattach()`'s
   * resolveContainerId `start`s it again on the next resume. Deliberately NOT
   * the folder ContainerBackend: no prepare/resumeEnv/destroy, so the CLI's
   * folder teardown paths (which would `sandbox.sh down` the worktree) cannot
   * engage.
   */
  writeBackBackend(): {
    suspend(envId: string): Promise<void>;
    finalize(envId: string): Promise<WriteBackFinalizeResult>;
    applyChanges(envId: string): Promise<WriteBackApplySummary>;
    discardChanges(envId: string): Promise<void>;
  } {
    return {
      suspend: async (envId: string): Promise<void> => {
        await this.docker(
          ['compose', '-p', composeProjectFromWorkingPath(envId), 'stop', 'agent'],
          { timeout: DOCKER_QUERY_TIMEOUT_MS }
        );
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
   * Best-effort teardown (mirrors WorktreeProvider.destroy's contract): shells
   * `sandbox.sh down`, which composes-down `-v` and removes the worktree +
   * `sandbox/<slug>` branch. A failure is swallowed — the run is already over.
   */
  async destroy(envId: string, _options?: WorktreeDestroyOptions): Promise<DestroyResult> {
    const { repo, slug } = repoSlugFromWorkingPath(envId);
    await this.runSandbox(['down', repo, slug], SANDBOX_DOWN_TIMEOUT_MS).catch(() => undefined);
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
    for (const entry of entries) {
      const name = entry.Name ?? '';
      if (!name.startsWith(prefix)) continue;
      const slug = name.slice(prefix.length);
      const containerId = await this.resolveContainerId(name).catch(() => '');
      if (!containerId) continue;
      envs.push(this.buildEnv(slug, `${WORKTREE_ROOT_BASE}/${repo}/${slug}`, name, containerId));
    }
    return envs;
  }

  async healthCheck(envId: string): Promise<boolean> {
    const { repo, slug } = repoSlugFromWorkingPath(envId);
    return this.composeAgentRunning(composeProjectFor(repo, slug));
  }

  /** Reject requests `sandbox.sh up` cannot honor (PR checkout, explicit --from). */
  private assertSupported(request: IsolationRequest): void {
    if (isPRIsolationRequest(request)) {
      throw new Error(
        'Container isolation cannot check out a PR: sandbox.sh cuts a fresh branch off ' +
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
          'sandbox.sh up cuts only from the base branch.'
      );
    }
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
      // sandbox.sh creates the branch as `sandbox/<slug>` off the base clone.
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
