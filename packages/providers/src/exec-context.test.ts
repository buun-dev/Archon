import { describe, test, expect } from 'bun:test';
import {
  remapContainerPath,
  isContainerStylePath,
  assertHostSpawnCwdSafe,
  type ContainerPathMap,
} from './types';

// The worktree lives in the WSL distro (POSIX path); the run meta dir is a host
// (win32) path bind-mounted at /archon-meta. A single pathMap remaps both, so a
// container whose mounts don't sit at the host cwd resolves every forwarded path.
const MAP: ContainerPathMap = [
  { hostPrefix: '/home/bunny/archon/worktrees/marphob-page/s1', containerPrefix: '/work' },
  {
    hostPrefix: 'C:\\Users\\Buun\\.archon\\workspaces\\buun-dev\\marphob-page',
    containerPrefix: '/archon-meta',
  },
];

describe('remapContainerPath', () => {
  test('returns the value unchanged when no pathMap is given', () => {
    expect(remapContainerPath('/work/foo', undefined)).toBe('/work/foo');
  });

  test('remaps an exact host worktree prefix to the container mount', () => {
    expect(remapContainerPath('/home/bunny/archon/worktrees/marphob-page/s1', MAP)).toBe('/work');
  });

  test('remaps a path under the worktree prefix, preserving the suffix', () => {
    expect(remapContainerPath('/home/bunny/archon/worktrees/marphob-page/s1/docs', MAP)).toBe(
      '/work/docs'
    );
  });

  test('remaps a win32 host meta prefix to /archon-meta, normalizing separators', () => {
    expect(
      remapContainerPath(
        'C:\\Users\\Buun\\.archon\\workspaces\\buun-dev\\marphob-page\\artifacts\\runs\\r1',
        MAP
      )
    ).toBe('/archon-meta/artifacts/runs/r1');
  });

  test('is boundary-safe — a partial prefix like /work does not swallow /workspace', () => {
    const map: ContainerPathMap = [{ hostPrefix: '/work', containerPrefix: '/x' }];
    expect(remapContainerPath('/workspace/foo', map)).toBe('/workspace/foo');
  });

  test('passes through a value outside every host prefix', () => {
    expect(remapContainerPath('/etc/hosts', MAP)).toBe('/etc/hosts');
  });

  test('leaves an empty value untouched', () => {
    expect(remapContainerPath('', MAP)).toBe('');
  });
});

describe('isContainerStylePath', () => {
  test('flags the sandbox mount roots and their subpaths', () => {
    expect(isContainerStylePath('/work')).toBe(true);
    expect(isContainerStylePath('/work/src/app.ts')).toBe(true);
    expect(isContainerStylePath('/home/bunny/archon/worktrees/repo/slug')).toBe(true);
    expect(isContainerStylePath('/archon-meta/logs')).toBe(true);
  });

  test('does not flag host paths or non-boundary near-matches', () => {
    expect(isContainerStylePath('D:\\Project\\x')).toBe(false);
    expect(isContainerStylePath('/homework')).toBe(false); // boundary: /home vs /homework
    expect(isContainerStylePath('/workspace/x')).toBe(false); // boundary: /work vs /workspace
    expect(isContainerStylePath('/usr/local/bin')).toBe(false);
  });
});

describe('assertHostSpawnCwdSafe', () => {
  const HOST = { kind: 'host' as const };
  const CONTAINER = { kind: 'container' as const, containerId: 'c' };

  test('throws on win32 for a HOST spawn at a container-style cwd (sandbox escape)', () => {
    expect(() => assertHostSpawnCwdSafe('/work', HOST, 'win32')).toThrow(/container-style/i);
    expect(() => assertHostSpawnCwdSafe('/home/bunny/x', HOST, 'win32')).toThrow(
      /escape|container/i
    );
  });

  test('no-op for a container execContext (docker exec owns the cwd)', () => {
    expect(() => assertHostSpawnCwdSafe('/work', CONTAINER, 'win32')).not.toThrow();
  });

  test('no-op on non-win32 hosts (leading-/ paths are real there)', () => {
    expect(() => assertHostSpawnCwdSafe('/work', HOST, 'linux')).not.toThrow();
  });

  test('allows a normal host cwd on win32', () => {
    expect(() => assertHostSpawnCwdSafe('D:\\Project\\repo', HOST, 'win32')).not.toThrow();
  });
});
