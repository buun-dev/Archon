/**
 * Isolation Provider Factory
 *
 * Centralized factory for isolation providers with config injection.
 * Currently only supports WorktreeProvider (git worktrees).
 */

import type { IIsolationProvider, RepoConfigLoader, IsolationProviderType } from './types';
import { WorktreeProvider } from './providers/worktree';
import { ContainerProvider, type ContainerProviderDeps } from './providers/container';

let provider: IIsolationProvider | null = null;
let configuredLoader: RepoConfigLoader = () => Promise.resolve(null);

/**
 * Configure the isolation system with a repo config loader.
 * Must be called before getIsolationProvider() for full functionality.
 * If not called, WorktreeProvider uses a no-op loader (no custom baseBranch, copyFiles, or path).
 */
export function configureIsolation(loader: RepoConfigLoader): void {
  configuredLoader = loader;
  provider = null; // Reset singleton so it picks up new loader
}

/**
 * Get the isolation provider instance (singleton).
 * Currently only returns WorktreeProvider.
 */
export function getIsolationProvider(): IIsolationProvider {
  provider ??= new WorktreeProvider(configuredLoader);
  return provider;
}

/**
 * Reset the isolation provider (for testing)
 */
export function resetIsolationProvider(): void {
  provider = null;
}

/**
 * Select the isolation provider for a repo-kind codebase from its resolved
 * `isolation.provider` config.
 *
 * `'container'` builds a FRESH ContainerProvider per dispatch — it carries a
 * run-specific containerId + pathMap, so it must not be the reusable singleton.
 * Anything else (undefined / `'worktree'`) returns the shared WorktreeProvider
 * from {@link getIsolationProvider} (host execution, byte-identical to today).
 */
export function selectIsolationProvider(
  providerType: IsolationProviderType | undefined,
  containerDeps: ContainerProviderDeps
): IIsolationProvider {
  if (providerType === 'container') {
    return new ContainerProvider(containerDeps);
  }
  return getIsolationProvider();
}
