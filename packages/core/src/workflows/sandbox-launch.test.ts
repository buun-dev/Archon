/**
 * The one check every non-CLI launch path makes before it runs a repo on the host.
 * Pure: it judges the repo config it is handed, so this file needs no module mocks.
 */
import { describe, expect, test } from 'bun:test';
import { assertRepoLaunchableOffCli, SandboxRepoLaunchRefusedError } from './sandbox-launch';

describe('assertRepoLaunchableOffCli', () => {
  test('a container repo is refused, naming the setting and the one launcher', () => {
    let caught: unknown;
    try {
      assertRepoLaunchableOffCli({
        isolation: { provider: 'container', provision: 'bun install' },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SandboxRepoLaunchRefusedError);
    const message = (caught as Error).message;
    expect(message).toContain('WSL sandbox');
    expect(message).toContain('isolation.provider: container');
    expect(message).toContain('only `archon workflow run` launches');
  });

  test('an unrecognized provider is refused by the recognition check, as the same error type', () => {
    const config = { isolation: { provider: 'contaner' } } as unknown as Parameters<
      typeof assertRepoLaunchableOffCli
    >[0];
    expect(() => assertRepoLaunchableOffCli(config)).toThrow(SandboxRepoLaunchRefusedError);
    expect(() => assertRepoLaunchableOffCli(config)).toThrow(
      "Unknown isolation.provider 'contaner'"
    );
  });

  test('a worktree repo, or one with no isolation setting, may launch here', () => {
    expect(() => assertRepoLaunchableOffCli({})).not.toThrow();
    expect(() => assertRepoLaunchableOffCli({ isolation: {} })).not.toThrow();
    expect(() => assertRepoLaunchableOffCli({ isolation: { provider: 'worktree' } })).not.toThrow();
  });
});
