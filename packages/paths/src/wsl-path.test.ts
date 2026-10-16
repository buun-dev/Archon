import { describe, test, expect } from 'bun:test';
import { toNodeVisiblePath } from './wsl-path';

describe('toNodeVisiblePath', () => {
  // A container inside the WSL2 distro cannot open `C:\...`; the same bytes are
  // reachable there as `/mnt/c/...`. This is the only translation the engine keeps,
  // and it exists because the engine is a Windows process and the nodes are not.
  const cases: readonly { name: string; input: string; want: string }[] = [
    {
      name: 'the run meta root',
      input: 'C:\\Users\\Buun\\.archon\\workspaces\\buun-dev\\marphob-page',
      want: '/mnt/c/Users/Buun/.archon/workspaces/buun-dev/marphob-page',
    },
    {
      name: 'a non-C drive',
      input: 'D:\\Project\\Archon-template',
      want: '/mnt/d/Project/Archon-template',
    },
    { name: 'a lowercase drive letter', input: 'c:\\tmp\\x', want: '/mnt/c/tmp/x' },
    {
      name: 'forward slashes on a Windows path',
      input: 'C:/Users/Buun/x',
      want: '/mnt/c/Users/Buun/x',
    },
    { name: 'a bare drive root', input: 'C:\\', want: '/mnt/c/' },
  ];

  for (const { name, input, want } of cases) {
    test(`converts ${name}`, () => {
      expect(toNodeVisiblePath(input)).toBe(want);
    });
  }

  // Pass-through, not an error: the function is called on every engine path, and
  // most runs have nothing to convert. A throw here would make the caller branch.
  test('returns a POSIX path unchanged', () => {
    expect(toNodeVisiblePath('/home/bunny/archon/worktrees/marphob-page/s1')).toBe(
      '/home/bunny/archon/worktrees/marphob-page/s1'
    );
  });

  test('returns an already-converted path unchanged', () => {
    expect(toNodeVisiblePath('/mnt/c/Users/Buun/x')).toBe('/mnt/c/Users/Buun/x');
  });

  test('returns a relative path unchanged', () => {
    expect(toNodeVisiblePath('docs/')).toBe('docs/');
  });

  test('returns an empty string unchanged', () => {
    expect(toNodeVisiblePath('')).toBe('');
  });
});
