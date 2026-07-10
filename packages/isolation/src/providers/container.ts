/**
 * Container Provider — per-run container isolation (step-5 sandbox P2).
 *
 * Instead of `git worktree add`, this provider shells the *already-validated*
 * P1 `sandbox.sh` lifecycle (up = worktree-in-distro + compose up + provision;
 * down = compose down + worktree remove). The engine stays on Windows; the
 * Windows `docker` CLI drives the Linux daemon natively, so `docker compose …`
 * state queries run WITHOUT wsl.exe. Only the git-provisioning script
 * (`sandbox.sh`, which lives in the distro FS) is invoked through `wsl.exe`.
 *
 * Addressing (from P1 `compose.yml.tmpl`): compose project `archon-<slug>`,
 * service `agent`, in-container workdir `/work` (the bind-mounted worktree).
 */

import { createHash } from 'crypto';

import { execFileAsync, toBranchName } from '@archon/git';

import { assertRequestSupported, resolveBaseBranch } from '../create-plan';
import type { ProviderCapabilities } from '../create-plan';
import type {
  DestroyResult,
  IIsolationProvider,
  IsolatedEnvironment,
  IsolationRequest,
  RepoConfigLoader,
  WorktreeDestroyOptions,
} from '../types';

/**
 * Real, LF-safe path to the P1 lifecycle script. Never a `/tmp` copy — the
 * script self-locates via `${BASH_SOURCE[0]}`, so a copy breaks its
 * `SANDBOX_DIR` resolution (P1 FIX-G lesson).
 */
const SANDBOX_SH = '/mnt/c/Users/Buun/.archon/sandbox/sandbox.sh';
const CONTAINER_WORKDIR = '/work';
/** Where `sandbox.sh` places the bind-mounted worktree in the distro FS. */
const WORKTREE_ROOT = '/home/bunny/archon/worktrees/marphob-page';
/**
 * The one repo this provider serves. `WORKTREE_ROOT` above and `sandbox.sh`'s
 * own `REPO_SLUG` both hardcode it, so `list()` cannot tell two repos apart —
 * every compose project is named `archon-<slug>` with no repo component. Rather
 * than return another repo's environments when asked about it, `list()` throws.
 * P4 (rollout beyond marphob-page) must make this a per-repo value; this
 * constant and `assertRepoInScope` are where that change lands.
 */
const SANDBOX_REPO_SLUG = 'marphob-page';

/** Last path segment, tolerating POSIX and Windows separators + trailing slash. */
function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * Guard the single-repo assumption. `codebaseId` is the canonical repo path
 * (see `IIsolationProvider.list`), so its basename is the repo name.
 */
function assertRepoInScope(codebaseId: string): void {
  const repo = basename(codebaseId);
  if (repo && repo !== SANDBOX_REPO_SLUG) {
    throw new Error(
      `ContainerProvider is scoped to "${SANDBOX_REPO_SLUG}" but was asked about "${repo}". ` +
        'Compose projects are named archon-<slug> with no repo component, so listing ' +
        `would return ${SANDBOX_REPO_SLUG}'s environments as if they were ${repo}'s.`
    );
  }
}

/** `sandbox.sh up` provisions (uv sync + pnpm install + alembic + playwright); be generous. */
const SANDBOX_UP_TIMEOUT_MS = 20 * 60 * 1000;
const SANDBOX_DOWN_TIMEOUT_MS = 5 * 60 * 1000;
const DOCKER_QUERY_TIMEOUT_MS = 30 * 1000;

/** Run `sandbox.sh <args>` inside the Ubuntu distro (git provisioning lives there). */
function runSandbox(
  args: string[],
  timeout: number,
  extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string }> {
  // wsl.exe does NOT forward arbitrary Windows env into the distro — only vars
  // named in WSLENV are translated. Forward the secrets `sandbox.sh` bakes into
  // the container via envsubst (compose.yml.tmpl): GH_TOKEN for in-container
  // `gh pr create` (P2 Task 10) and ANTHROPIC_API_KEY. `/u` = Windows → WSL only.
  const forwarded = ['GH_TOKEN', 'ANTHROPIC_API_KEY', ...Object.keys(extraEnv)];
  const wslenv = [process.env.WSLENV, ...forwarded.map(name => `${name}/u`)]
    .filter(Boolean)
    .join(':');
  return execFileAsync('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', SANDBOX_SH, ...args], {
    timeout,
    env: { ...process.env, ...extraEnv, WSLENV: wslenv },
  });
}

/**
 * The originating user's git identity, as env for `sandbox.sh`. WorktreeProvider
 * stamps it with `git config` on the new worktree; this provider cannot — the
 * worktree is a distro path Windows git cannot reach — so `sandbox.sh` stamps it
 * where the filesystem is. Empty when absent (solo installs), leaving the
 * script's own fallback identity in force.
 */
function identityEnv(request: IsolationRequest): Record<string, string> {
  const identity = request.gitIdentity;
  if (!identity?.email) return {};
  return {
    ARCHON_GIT_USER_EMAIL: identity.email,
    ...(identity.name ? { ARCHON_GIT_USER_NAME: identity.name } : {}),
  };
}

export class ContainerProvider implements IIsolationProvider {
  readonly providerType = 'container' as const;

  /**
   * `sandbox.sh cmd_up` takes a slug and a base branch and nothing else, then
   * runs `git worktree add -b sandbox/<slug> origin/<base>`. So this provider:
   *
   *  - cannot cut from an explicit `--from` start-point, and
   *  - cannot check out a PR at all — it would create a fresh branch off the
   *    base and review `origin/<base>` while reporting on the PR.
   *
   * Declaring that here makes `assertRequestSupported` reject those requests
   * instead of honoring them incorrectly and in silence.
   */
  static readonly capabilities: ProviderCapabilities = {
    startPointOverride: false,
    prCheckout: false,
  };

  constructor(private loadConfig: RepoConfigLoader = () => Promise.resolve(null)) {}

  async create(request: IsolationRequest): Promise<IsolatedEnvironment> {
    // Reject before provisioning anything: a dropped `--from` would cut the
    // worktree from origin/<base>, go green, and open the PR on the wrong base.
    assertRequestSupported(request, ContainerProvider.capabilities, this.providerType);

    const slug = this.slugFor(request);
    const workingPath = `${WORKTREE_ROOT}/${slug}`;
    // The worktree lives in the distro, so the branch has to cross the wsl.exe
    // boundary as an argument; auto-detection runs against the host checkout,
    // which Windows git can reach.
    const baseBranch = await resolveBaseBranch(request, this.loadConfig);
    // Worktree-in-distro + compose up + provision. No port allocator — the
    // container owns its own 3000/8123/5432 in its private network namespace.
    await runSandbox(['up', slug, baseBranch], SANDBOX_UP_TIMEOUT_MS, identityEnv(request));
    return this.buildEnv(slug, workingPath, request);
  }

  /**
   * Best-effort teardown (mirrors WorktreeProvider.destroy's contract): shells
   * `sandbox.sh down`, which composes-down `-v` and removes the worktree +
   * `sandbox/<slug>` branch. A failure is swallowed — the run is already over.
   */
  async destroy(envId: string, _options?: WorktreeDestroyOptions): Promise<DestroyResult> {
    const slug = this.slugFromWorkingPath(envId);
    await runSandbox(['down', slug], SANDBOX_DOWN_TIMEOUT_MS).catch(() => undefined);
    return {
      worktreeRemoved: true,
      branchDeleted: null,
      remoteBranchDeleted: null,
      directoryClean: true,
      warnings: [],
    };
  }

  async get(envId: string): Promise<IsolatedEnvironment | null> {
    const slug = this.slugFromWorkingPath(envId);
    if (!(await this.composeAgentRunning(slug))) {
      return null;
    }
    return this.buildEnv(slug, envId);
  }

  async list(codebaseId: string): Promise<IsolatedEnvironment[]> {
    assertRepoInScope(codebaseId);
    let stdout = '[]';
    try {
      ({ stdout } = await execFileAsync('docker', ['compose', 'ls', '--all', '--format', 'json'], {
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
    return entries
      .map(e => e.Name ?? '')
      .filter(name => name.startsWith('archon-'))
      .map(name =>
        this.buildEnv(
          name.slice('archon-'.length),
          `${WORKTREE_ROOT}/${name.slice('archon-'.length)}`
        )
      );
  }

  async healthCheck(envId: string): Promise<boolean> {
    return this.composeAgentRunning(this.slugFromWorkingPath(envId));
  }

  /** `docker compose -p archon-<slug> ps` → is the `agent` service running? */
  private async composeAgentRunning(slug: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['compose', '-p', `archon-${slug}`, 'ps', '--status', 'running', '--format', 'json'],
        { timeout: DOCKER_QUERY_TIMEOUT_MS }
      );
      return /"Service"\s*:\s*"agent"/.test(stdout);
    } catch {
      return false;
    }
  }

  /** Assemble the ContainerEnvironment literal for a slug/workingPath. */
  private buildEnv(
    slug: string,
    workingPath: string,
    request?: IsolationRequest
  ): IsolatedEnvironment {
    return {
      id: workingPath,
      provider: 'container',
      workingPath,
      project: `archon-${slug}`,
      containerWorkdir: CONTAINER_WORKDIR,
      // sandbox.sh creates the branch as `sandbox/<slug>` off the base clone.
      branchName: toBranchName(`sandbox/${slug}`),
      status: 'active',
      createdAt: new Date(),
      metadata: { adopted: false, ...(request ? { request } : {}) },
    };
  }

  /**
   * Slug = the WorktreeProvider branch name with the `archon/` org-prefix
   * stripped and any remaining `/` flattened to `-`, so it is a single
   * filesystem-safe path segment and compose-project suffix. Mirrors the
   * worktree branch-name rule so ledger linkage stays consistent.
   */
  private slugFor(request: IsolationRequest): string {
    return this.generateBranchName(request)
      .replace(/^archon\//, '')
      .replace(/\//g, '-');
  }

  /** envId is, by contract, the worktree working path; the slug is its last segment. */
  private slugFromWorkingPath(envId: string): string {
    return (
      envId
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .filter(Boolean)
        .pop() ?? ''
    );
  }

  // --- Branch-name helpers copied verbatim from WorktreeProvider so the slug
  //     derivation stays byte-identical across providers. ---

  generateBranchName(request: IsolationRequest): string {
    switch (request.workflowType) {
      case 'issue':
        return `archon/issue-${request.identifier}`;
      case 'pr':
        if (!request.isForkPR) {
          return request.prBranch;
        }
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
