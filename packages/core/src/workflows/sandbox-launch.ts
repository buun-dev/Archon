import { assertIsolationProviderRecognized } from '@archon/isolation';
import type { RepoConfig } from '../config/config-types';

/**
 * A launch refused because the repo runs in the WSL sandbox, or names an isolation
 * provider nothing implements. The message is operator guidance naming the setting;
 * deliver it verbatim.
 */
export class SandboxRepoLaunchRefusedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxRepoLaunchRefusedError';
  }
}

/**
 * The one check every launch path other than `archon workflow run` makes before it runs
 * a repo on the host: before it cuts or reuses a worktree, or runs in the live checkout.
 * A repo whose `.archon/config.yaml` sets `isolation.provider: container` runs only in
 * the WSL sandbox, and only the CLI provisions one. Chat and web dispatch, resource
 * starts and triggers, and `/worktree` would otherwise run it on the host without a
 * word. An unrecognized provider is refused by {@link assertIsolationProviderRecognized},
 * as the same error type.
 *
 * Not called by the CLI, which decides in `resolveRepoIsolationProvider` and reaches the
 * host worktree path only for a worktree repo. Not called for a sub-run's own worktree
 * (the child isolation resolver): its root run's launch was already judged, and a
 * sandbox run refuses `workflow:` nodes.
 */
export function assertRepoLaunchableOffCli(repoConfig: Pick<RepoConfig, 'isolation'>): void {
  const provider = repoConfig.isolation?.provider;
  try {
    assertIsolationProviderRecognized(provider);
  } catch (err) {
    throw new SandboxRepoLaunchRefusedError((err as Error).message, { cause: err });
  }
  if (provider === 'container') {
    throw new SandboxRepoLaunchRefusedError(
      'This repo runs in the WSL sandbox (`isolation.provider: container` in ' +
        '.archon/config.yaml), which only `archon workflow run` launches; continue its runs ' +
        'with `archon workflow resume`. Start it from the CLI, or set isolation.provider to ' +
        'worktree to run it here.'
    );
  }
}
