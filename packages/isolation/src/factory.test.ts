import { describe, test, expect, afterEach } from 'bun:test';
import {
  getIsolationProvider,
  resetIsolationProvider,
  configureIsolation,
  selectIsolationProvider,
} from './factory';

describe('Isolation Provider Factory', () => {
  afterEach(() => {
    resetIsolationProvider();
  });

  test('getIsolationProvider returns same instance on repeated calls', () => {
    const first = getIsolationProvider();
    const second = getIsolationProvider();
    expect(first).toBe(second);
  });

  test('resetIsolationProvider clears singleton so next call returns new instance', () => {
    const first = getIsolationProvider();
    resetIsolationProvider();
    const second = getIsolationProvider();
    expect(first).not.toBe(second);
  });

  test('configureIsolation resets singleton', () => {
    const first = getIsolationProvider();
    configureIsolation(async () => null);
    const second = getIsolationProvider();
    expect(first).not.toBe(second);
  });

  test('provider type is worktree', () => {
    const provider = getIsolationProvider();
    expect(provider.providerType).toBe('worktree');
  });

  test('selectIsolationProvider returns a ContainerProvider for provider="container"', () => {
    const provider = selectIsolationProvider('container', {});
    expect(provider.providerType).toBe('container');
  });

  test('selectIsolationProvider falls back to the worktree singleton for undefined/"worktree"', () => {
    const singleton = getIsolationProvider();
    expect(selectIsolationProvider(undefined, {})).toBe(singleton);
    expect(selectIsolationProvider('worktree', {})).toBe(singleton);
  });
});

/**
 * The silent-fallback defect (slice 4). `isolation.provider` is a TypeScript
 * type erased at runtime and `loadRepoConfig` does not validate it, so a typo in
 * `.archon/config.yaml` used to fall through the `=== 'container'` test and hand
 * back the WORKTREE provider: the operator asked for container isolation, got a
 * host run, and nothing said so.
 */
describe('selectIsolationProvider — unrecognised isolation.provider', () => {
  afterEach(() => {
    resetIsolationProvider();
  });

  test('refuses a misspelled provider instead of silently running on the host', () => {
    const worktreeSingleton = getIsolationProvider();
    // The cast is the point: this value arrives from YAML, where the type is gone.
    let outcome: unknown = 'never ran';
    try {
      outcome = selectIsolationProvider('contaner' as 'container', {});
    } catch (err) {
      outcome = err;
    }
    // The defect was that `outcome` came back as the worktree provider and the run
    // proceeded on the host. Assert the run cannot become a host run, not merely
    // that something was thrown.
    expect(outcome).not.toBe(worktreeSingleton);
    expect((outcome as { providerType?: string }).providerType).toBeUndefined();
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/isolation\.provider/);
  });

  test('the refusal names the bad value, the valid ones, and the file to edit', () => {
    try {
      selectIsolationProvider('contaner' as 'container', {});
      throw new Error('expected selectIsolationProvider to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("'contaner'");
      expect(message).toContain('worktree');
      expect(message).toContain('container');
      expect(message).toContain('.archon/config.yaml');
    }
  });
});
