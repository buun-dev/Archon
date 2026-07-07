import { describe, test, expect, afterEach } from 'bun:test';
import { getIsolationProvider, resetIsolationProvider, configureIsolation } from './factory';

describe('Isolation Provider Factory', () => {
  afterEach(() => {
    resetIsolationProvider();
    // Reset the configured kind back to the default so a container-kind test
    // doesn't leak into the next test (resetIsolationProvider only nulls the singleton).
    configureIsolation(async () => null, 'worktree');
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

  test('configureIsolation with kind "container" yields a ContainerProvider (two-way door)', () => {
    configureIsolation(async () => null, 'container');
    const provider = getIsolationProvider();
    expect(provider.providerType).toBe('container');
  });

  test('configureIsolation defaults to worktree kind when kind omitted', () => {
    configureIsolation(async () => null);
    const provider = getIsolationProvider();
    expect(provider.providerType).toBe('worktree');
  });

  test('configureIsolation with explicit "worktree" yields a WorktreeProvider', () => {
    configureIsolation(async () => null, 'worktree');
    const provider = getIsolationProvider();
    expect(provider.providerType).toBe('worktree');
  });
});
