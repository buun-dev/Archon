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
import type {
  DestroyResult,
  IIsolationProvider,
  IsolatedEnvironment,
  IsolationRequest,
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

/** `sandbox.sh up` provisions (uv sync + pnpm install + alembic + playwright); be generous. */
const SANDBOX_UP_TIMEOUT_MS = 20 * 60 * 1000;
const SANDBOX_DOWN_TIMEOUT_MS = 5 * 60 * 1000;
const DOCKER_QUERY_TIMEOUT_MS = 30 * 1000;

/** Run `sandbox.sh <args>` inside the Ubuntu distro (git provisioning lives there). */
function runSandbox(args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  // wsl.exe does NOT forward arbitrary Windows env into the distro — only vars
  // named in WSLENV are translated. Forward the secrets `sandbox.sh` bakes into
  // the container via envsubst (compose.yml.tmpl): GH_TOKEN for in-container
  // `gh pr create` (P2 Task 10) and ANTHROPIC_API_KEY. `/u` = Windows → WSL only.
  const wslenv = [process.env.WSLENV, 'GH_TOKEN/u', 'ANTHROPIC_API_KEY/u']
    .filter(Boolean)
    .join(':');
  return execFileAsync('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', SANDBOX_SH, ...args], {
    timeout,
    env: { ...process.env, WSLENV: wslenv },
  });
}

export class ContainerProvider implements IIsolationProvider {
  readonly providerType = 'container' as const;

  async create(request: IsolationRequest): Promise<IsolatedEnvironment> {
    const slug = this.slugFor(request);
    const workingPath = `${WORKTREE_ROOT}/${slug}`;
    // Worktree-in-distro + compose up + provision. No port allocator — the
    // container owns its own 3000/8123/5432 in its private network namespace.
    await runSandbox(['up', slug], SANDBOX_UP_TIMEOUT_MS);
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

  async list(_codebaseId: string): Promise<IsolatedEnvironment[]> {
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
