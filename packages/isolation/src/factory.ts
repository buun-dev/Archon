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
 * The `isolation.provider` values `.archon/config.yaml` accepts. Narrower than
 * `IsolationProviderType`, which also names providers no config can request.
 */
const CONFIGURABLE_PROVIDERS = ['worktree', 'container'] as const;

/**
 * Refuse an `isolation.provider` value nothing implements (slice 4, #2206:
 * "Unsupported or incomplete configuration fails before a run starts and names
 * the setting the operator must correct").
 *
 * The parameter is TYPED, but the value is not: it is read verbatim out of YAML
 * by `loadRepoConfig`, which validates nothing and — being fail-soft — could not
 * refuse it there anyway (an invalid config returns `{}` and the run proceeds).
 * Before this guard, `isolation: { provider: contaner }` fell through the
 * `=== 'container'` test below and handed back the WORKTREE provider: the
 * operator asked for container isolation, silently got a host run, and nothing
 * in the output said so.
 */
export function assertIsolationProviderRecognized(
  providerType: IsolationProviderType | undefined
): void {
  if (providerType === undefined || providerType === null) return;
  if ((CONFIGURABLE_PROVIDERS as readonly string[]).includes(providerType)) return;
  throw new Error(
    `Unknown isolation.provider '${providerType}' in .archon/config.yaml. ` +
      "Valid values are 'worktree' (the default — a git worktree on the host) and " +
      "'container' (the WSL sandbox). Correct the setting, or remove it to run on the host."
  );
}

/**
 * Select the isolation provider for a repo-kind codebase from its resolved
 * `isolation.provider` config.
 *
 * `'container'` builds a FRESH ContainerProvider per dispatch — it carries a
 * run-specific containerId, so it must not be the reusable singleton.
 * Anything else (undefined / `'worktree'`) returns the shared WorktreeProvider
 * from {@link getIsolationProvider} (host execution, byte-identical to today).
 */
export function selectIsolationProvider(
  providerType: IsolationProviderType | undefined,
  containerDeps: ContainerProviderDeps
): IIsolationProvider {
  assertIsolationProviderRecognized(providerType);
  if (providerType === 'container') {
    return new ContainerProvider(containerDeps);
  }
  return getIsolationProvider();
}
