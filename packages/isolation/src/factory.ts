/**
 * Isolation Provider Factory
 *
 * Centralized factory for isolation providers with config injection.
 * Currently only supports WorktreeProvider (git worktrees).
 */

import type { IIsolationProvider, IsolationProviderType, RepoConfigLoader } from './types';
import { WorktreeProvider } from './providers/worktree';
import { ContainerProvider } from './providers/container';

let provider: IIsolationProvider | null = null;
let configuredLoader: RepoConfigLoader = () => Promise.resolve(null);
let configuredKind: IsolationProviderType = 'worktree';

/**
 * Configure the isolation system with a repo config loader and (optionally) the
 * resolved isolation kind for the repo being dispatched.
 * Must be called before getIsolationProvider() for full functionality.
 * If not called, WorktreeProvider uses a no-op loader (no custom baseBranch, copyFiles, or path).
 *
 * `kind` defaults to `'worktree'` so absent/omitted config is byte-identical to
 * today (the step-5 two-way door: `.archon/config.yaml` isolation.provider flips it).
 */
export function configureIsolation(
  loader: RepoConfigLoader,
  kind: IsolationProviderType = 'worktree'
): void {
  configuredLoader = loader;
  configuredKind = kind;
  provider = null; // Reset singleton so it picks up new loader/kind
}

/**
 * Get the isolation provider instance (singleton).
 * Returns a ContainerProvider when the resolved kind is 'container' (step-5 P2),
 * otherwise the default WorktreeProvider.
 */
export function getIsolationProvider(): IIsolationProvider {
  provider ??=
    configuredKind === 'container'
      ? new ContainerProvider()
      : new WorktreeProvider(configuredLoader);
  return provider;
}

/**
 * Reset the isolation provider (for testing)
 */
export function resetIsolationProvider(): void {
  provider = null;
}
