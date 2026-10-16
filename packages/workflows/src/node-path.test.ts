import { describe, expect, test } from 'bun:test';
import {
  currentNodeVisibility,
  nodePathBindingFor,
  runWithNodePaths,
  toNodePath,
} from './node-path';

describe('node path binding', () => {
  test('toNodePath is identity when unbound', () => {
    expect(toNodePath('C:\\a\\b')).toBe('C:\\a\\b');
    expect(currentNodeVisibility()).toBe('host');
  });

  test('a wsl binding converts C:\\a\\b to /mnt/c/a/b', async () => {
    const seen = await runWithNodePaths(nodePathBindingFor('wsl'), async () => ({
      path: toNodePath('C:\\a\\b'),
      visibility: currentNodeVisibility(),
    }));

    expect(seen).toEqual({ path: '/mnt/c/a/b', visibility: 'wsl' });
  });

  // A child sub-run's executeWorkflow binds its own visibility inside its parent's
  // scope; the child's binding must win, or a host child would receive WSL paths.
  test('an inner host binding shadows an outer wsl binding', async () => {
    const seen = await runWithNodePaths(nodePathBindingFor('wsl'), () =>
      runWithNodePaths(nodePathBindingFor('host'), async () => ({
        path: toNodePath('C:\\x'),
        visibility: currentNodeVisibility(),
      }))
    );

    expect(seen).toEqual({ path: 'C:\\x', visibility: 'host' });
  });
});
