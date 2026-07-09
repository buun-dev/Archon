import { describe, test, expect, afterEach, spyOn } from 'bun:test';

import * as git from '@archon/git';
import { getIsolationProvider, resetIsolationProvider, configureIsolation } from './factory';
import type { IsolationRequest } from './types';

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

  // The factory built `new ContainerProvider()` with no loader, so the container
  // path never saw `.archon/config.yaml` and could not resolve a base branch (P3-F).
  test('configureIsolation wires the repo-config loader into ContainerProvider', async () => {
    const execSpy = spyOn(git, 'execFileAsync');
    execSpy.mockResolvedValue({ stdout: '', stderr: '' });
    const defaultBranchSpy = spyOn(git, 'getDefaultBranch');
    defaultBranchSpy.mockResolvedValue(
      'master' as Awaited<ReturnType<typeof git.getDefaultBranch>>
    );

    let seenRepoPath: string | null = null;
    configureIsolation(async repoPath => {
      seenRepoPath = repoPath;
      return { baseBranch: 'develop' };
    }, 'container');

    const request: IsolationRequest = {
      workflowType: 'issue',
      identifier: '42',
      codebaseId: 'cb1',
      canonicalRepoPath: '/repo/marphob-page' as unknown as IsolationRequest['canonicalRepoPath'],
    };
    await getIsolationProvider().create(request);

    expect(seenRepoPath).toBe('/repo/marphob-page');
    const argv = execSpy.mock.calls[0]![1] as string[];
    expect(argv.slice(-3)).toEqual(['up', 'issue-42', 'develop']);

    execSpy.mockRestore();
    defaultBranchSpy.mockRestore();
  });
});
