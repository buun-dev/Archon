import { describe, test, expect } from 'bun:test';

import { isHostVisibleEnv } from './types';

// The host filesystem is NOT the source of truth for every provider's working
// path. A `container` env's worktree lives inside the WSL distro, which the
// Windows host cannot stat — so a host `existsSync`/`worktreeExists` on it
// ALWAYS false-negatives. Callers that read that false-negative as "the worktree
// is gone" destroy the DB row of a LIVE run (step-5 rollout P1, 2026-07-14).
describe('isHostVisibleEnv', () => {
  test('a worktree env IS host-visible — its path is a real host directory', () => {
    expect(isHostVisibleEnv('worktree')).toBe(true);
  });

  test('a container env is NOT host-visible — its path lives in the WSL distro', () => {
    expect(isHostVisibleEnv('container')).toBe(false);
  });
});
