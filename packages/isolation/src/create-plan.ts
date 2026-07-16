/**
 * Shared pre-create resolution for isolation providers.
 *
 * Why this file exists (step-5 sandbox, retro 2026-07-09):
 * `ContainerProvider` was written beside `WorktreeProvider` by copying the parts
 * its author needed. TypeScript checks that both implement the interface's
 * *methods*; nothing checks that both read the same `IsolationRequest` *fields*.
 * So every field the newer provider forgot became a silent behavioral divergence
 * — the worktree got cut from the wrong start-point, CI went green, and the PR
 * opened on the wrong base. Three fields were lost this way before anyone
 * noticed (`gitIdentity`, the base branch, then `fromBranch`/`prSha`).
 *
 * Two mechanisms, both here:
 *
 *  1. `ProviderCapabilities` — each provider *declares* which optional request
 *     fields it honors. `assertRequestSupported` throws when a request carries a
 *     field the provider cannot honor. A silent drop becomes a loud dispatch-time
 *     error, which is worth more than parity nobody can prove.
 *
 *  2. `resolveStartPoint` / `resolveBaseBranch` — the decisions both providers
 *     must make, made once. A new start-point rule lands in one place.
 *
 * `ProviderCapabilities` is a total map over `CapabilityKey`, so adding a new
 * optional request field and its capability key fails the build until every
 * provider states its position.
 */

import { getDefaultBranch } from '@archon/git';

import type { IsolationProviderType, IsolationRequest, RepoConfigLoader } from './types';

/**
 * One key per behavior whose neglect is silent — where the branch is cut from,
 * or which commit is checked out.
 *
 * Deliberately NOT covered: `codebaseName` and `codebaseId`. `WorktreeProvider`
 * reads them only to lay out `<workspaces>/<owner>/<repo>/worktrees/...`;
 * `ContainerProvider` roots every worktree under `<WORKTREE_ROOT_BASE>/<repo>`,
 * deriving `<repo>` from `request.canonicalRepoPath`. That divergence is an
 * intentional layout choice, not a capability.
 */
export type CapabilityKey = 'startPointOverride' | 'prCheckout' | 'baseOverride';

/**
 * What a provider promises to honor. Every key is required — a provider cannot
 * stay silent about a behavior, which is the whole point.
 */
export type ProviderCapabilities = Record<CapabilityKey, boolean>;

/** Human-facing description of the behavior each capability governs. */
const CAPABILITY_FIELD: Record<CapabilityKey, string> = {
  startPointOverride: 'fromBranch (--from)',
  prCheckout: "PR checkout (the PR's own branch, or a fork's pinned prSha)",
  baseOverride: 'baseBranch (--base)',
};

/**
 * Which capabilities a given request actually exercises. A request that never
 * sets `fromBranch` needs no `startPointOverride` support, so a provider lacking
 * it is still free to run — that is exactly why the container path stayed clean
 * across three `task` dispatches that never passed `--from`.
 */
export function requiredCapabilities(request: IsolationRequest): CapabilityKey[] {
  const required: CapabilityKey[] = [];
  if (request.workflowType === 'task' && request.fromBranch) {
    required.push('startPointOverride');
  }
  if (request.workflowType === 'task' && request.baseBranch) {
    required.push('baseOverride');
  }
  // Every PR workflow needs the PR's code. A provider that always cuts a fresh
  // branch from `origin/<base>` would review the base branch and report on it
  // as though it were the PR — silently, and with a green run.
  if (request.workflowType === 'pr') {
    required.push('prCheckout');
  }
  return required;
}

/**
 * Throw when the request needs something the provider does not implement.
 *
 * Fail loud, at dispatch, before a worktree exists — never silently continue
 * with a different start-point than the caller asked for.
 */
export function assertRequestSupported(
  request: IsolationRequest,
  capabilities: ProviderCapabilities,
  providerType: IsolationProviderType
): void {
  const unsupported = requiredCapabilities(request).filter(key => !capabilities[key]);
  if (unsupported.length === 0) return;

  const fields = unsupported.map(key => CAPABILITY_FIELD[key]).join(', ');
  throw new Error(
    `Isolation provider "${providerType}" cannot honor: ${fields}. ` +
      'Ignoring these would silently change where the branch is cut from. ' +
      'Dispatch this repo with isolation.provider=worktree, or implement the ' +
      "capability and flip it in the provider's declaration."
  );
}

/**
 * The base branch a new worktree syncs against: a per-dispatch task `--base`
 * override wins first, else repo config wins, else the repo's default branch.
 * Never a hardcoded fallback — `getDefaultBranch` throws when it cannot
 * resolve, which is the loud behavior `syncWorkspaceBeforeCreate` already
 * relies on.
 */
export async function resolveBaseBranch(
  request: IsolationRequest,
  loadConfig: RepoConfigLoader
): Promise<string> {
  // A per-dispatch --base wins over config and default (couples cut-from to
  // the PR target for epic slices). Narrowed to task — only tasks carry it.
  if (request.workflowType === 'task' && request.baseBranch) {
    return request.baseBranch;
  }
  const config = await loadConfig(request.canonicalRepoPath);
  return config?.baseBranch ?? (await getDefaultBranch(request.canonicalRepoPath));
}

/**
 * The commit-ish a new branch is cut from. An explicit `--from` on a task
 * overrides the base branch; everything else cuts from `origin/<baseBranch>`.
 *
 * Callers must have already run `assertRequestSupported`, so a provider without
 * `startPointOverride` never reaches the override arm.
 */
export function resolveStartPoint(
  request: IsolationRequest,
  baseBranch: string
): { startPoint: string; isOverride: boolean } {
  if (request.workflowType === 'task' && request.fromBranch) {
    return { startPoint: request.fromBranch, isOverride: true };
  }
  return { startPoint: `origin/${baseBranch}`, isOverride: false };
}
