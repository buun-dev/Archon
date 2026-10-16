/**
 * Isolation Provider Factory
 *
 * Centralized factory for isolation providers with config injection.
 * The shared provider is the WorktreeProvider (git worktrees); a repo whose
 * config asks for container isolation gets its own ContainerProvider per dispatch.
 */

import type {
  IContainerIsolationProvider,
  IIsolationProvider,
  RepoConfigLoader,
  WorktreeSetupExecutor,
} from './types';
import { WorktreeProvider } from './providers/worktree';
import { ContainerProvider, type ContainerProviderDeps } from './providers/container';

let configuredExecutor: WorktreeSetupExecutor | undefined;
let provider: IIsolationProvider | null = null;
let configuredLoader: RepoConfigLoader = () => Promise.resolve(null);

/**
 * Configure the isolation system with a repo config loader.
 * Must be called before getIsolationProvider() for full functionality.
 * If not called, WorktreeProvider uses a no-op loader (no custom baseBranch, copyFiles, or path).
 */
export function configureIsolation(
  loader: RepoConfigLoader,
  setupExecutor?: WorktreeSetupExecutor
): void {
  configuredLoader = loader;
  configuredExecutor = setupExecutor;
  provider = null; // Reset singleton so it picks up new loader
}

/**
 * Get the isolation provider instance (singleton).
 * Currently only returns WorktreeProvider.
 */
export function getIsolationProvider(): IIsolationProvider {
  provider ??= new WorktreeProvider(configuredLoader, configuredExecutor);
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
/** One of {@link CONFIGURABLE_PROVIDERS}; the repo config type derives its field from it. */
export type ConfigurableProvider = (typeof CONFIGURABLE_PROVIDERS)[number];

/**
 * Refuse an `isolation.provider` value nothing implements (slice 4, #2206:
 * "Unsupported or incomplete configuration fails before a run starts and names
 * the setting the operator must correct").
 *
 * The value is read verbatim out of YAML by `loadRepoConfig`, which validates
 * nothing and — being fail-soft — could not refuse it there anyway (an invalid
 * config returns `{}` and the run proceeds). Without this guard,
 * `isolation: { provider: contaner }` fell through the `=== 'container'` test in
 * {@link selectIsolationProvider} and handed back the WORKTREE provider: the
 * operator asked for container isolation, silently got a host run, and nothing
 * in the output said so. A key present with no value (YAML `null`) is refused
 * too: it is not "unset".
 */
export function assertIsolationProviderRecognized(
  providerType: unknown
): asserts providerType is ConfigurableProvider | undefined {
  if (providerType === undefined) return;
  if (CONFIGURABLE_PROVIDERS.some(p => p === providerType)) return;
  throw new Error(
    `Unknown isolation.provider '${String(providerType)}' in .archon/config.yaml. ` +
      "Valid values are 'worktree' (the default — a git worktree on the host) and " +
      "'container' (the WSL sandbox). Correct the setting, or remove it to run on the host."
  );
}

/**
 * Select the isolation provider for a repo-kind codebase from its resolved
 * `isolation.provider` config.
 *
 * `'container'` builds a FRESH ContainerProvider per dispatch and returns it as
 * an {@link IContainerIsolationProvider} — it carries a run-specific
 * containerId, so it must not be the reusable singleton.
 * Anything else (undefined / `'worktree'`) returns the shared WorktreeProvider
 * from {@link getIsolationProvider} (host execution, byte-identical to today).
 *
 * Re-asserts the value: the parameter's type is erased by the time YAML
 * reaches it, and a cast value must not fall through to a host run.
 */
export function selectIsolationProvider(
  providerType: ConfigurableProvider | undefined,
  containerDeps: ContainerProviderDeps
): IIsolationProvider | IContainerIsolationProvider {
  assertIsolationProviderRecognized(providerType);
  if (providerType === 'container') {
    return new ContainerProvider(containerDeps);
  }
  return getIsolationProvider();
}

/** Narrow {@link selectIsolationProvider}'s result to the container provider. */
export function isContainerIsolationProvider(
  p: IIsolationProvider | IContainerIsolationProvider
): p is IContainerIsolationProvider {
  return p.providerType === 'container';
}
