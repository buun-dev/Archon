import { describe, test, expect } from 'bun:test';
import { ContainerProvider } from './container';
import type { IsolationRequest } from '../types';

/**
 * Fake runners so create() is unit-testable without a real WSL distro / docker
 * daemon. `runSandbox` records every `sandbox.sh` invocation; `docker` answers
 * the `compose -p <project> ps -q agent` container-id resolution.
 */
function makeRunners(containerId = 'container-abc') {
  const calls: { sandbox: string[][]; docker: string[][] } = { sandbox: [], docker: [] };
  const runSandbox = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.sandbox.push(args);
    return { stdout: '', stderr: '' };
  };
  const docker = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.docker.push(args);
    if (args.includes('ps')) return { stdout: `${containerId}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { calls, runSandbox, docker };
}

const BASE_REQ = {
  canonicalRepoPath: '/repo/marphob-page',
  codebaseId: 'cb1',
  codebaseName: 'marphob-page',
  baseBranch: 'main',
} as const;

describe('ContainerProvider.create', () => {
  test('brings up the WSL sandbox and returns a container execContext at /work', async () => {
    const { calls, runSandbox, docker } = makeRunners();
    const provider = new ContainerProvider({ runSandbox, docker, loadConfig: async () => null });

    const env = await provider.create({
      ...BASE_REQ,
      workflowType: 'task',
      identifier: 'my-task',
    } as IsolationRequest);

    // sandbox.sh up <repo> <slug> <base>
    const up = calls.sandbox.find(a => a[0] === 'up');
    expect(up?.slice(0, 3)).toEqual(['up', 'marphob-page', 'task-my-task']);

    expect(env.provider).toBe('container');
    if (env.provider !== 'container') throw new Error('expected a container environment');
    expect(env.execContext.kind).toBe('container');
    expect(env.execContext.containerId).toBe('container-abc');
    expect(env.execContext.workdir).toBe('/work');
    expect(env.execContext.pathMap?.some(m => m.containerPrefix === '/work')).toBe(true);
    expect(env.execContext.pathMap?.some(m => m.containerPrefix === '/archon-meta')).toBe(true);
    expect(env.branchName).toBe('sandbox/task-my-task');
    expect(env.project).toBe('archon-marphob-page-task-my-task');
  });

  test('resolves the container id via `docker compose -p <project> ps -q agent`', async () => {
    const { calls, runSandbox, docker } = makeRunners('cid-xyz');
    const provider = new ContainerProvider({ runSandbox, docker, loadConfig: async () => null });

    const env = await provider.create({
      ...BASE_REQ,
      workflowType: 'task',
      identifier: 't',
    } as IsolationRequest);

    const ps = calls.docker.find(a => a.includes('ps'));
    expect(ps).toContain('-p');
    expect(ps).toContain('archon-marphob-page-task-t');
    expect(ps).toContain('agent');
    if (env.provider !== 'container') throw new Error('expected a container environment');
    expect(env.execContext.containerId).toBe('cid-xyz');
  });

  test('base precedence: baseOverride wins over repo config and request.baseBranch', async () => {
    const { calls, runSandbox, docker } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      loadConfig: async () => ({ baseBranch: 'develop' }),
    });

    await provider.create({
      ...BASE_REQ,
      workflowType: 'task',
      identifier: 't',
      baseBranch: 'main',
      baseOverride: 'release',
    } as IsolationRequest);

    const up = calls.sandbox.find(a => a[0] === 'up');
    expect(up?.[3]).toBe('release');
  });

  test('base precedence: repo config wins over request.baseBranch when no override', async () => {
    const { calls, runSandbox, docker } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      loadConfig: async () => ({ baseBranch: 'develop' }),
    });

    await provider.create({
      ...BASE_REQ,
      workflowType: 'task',
      identifier: 't',
      baseBranch: 'main',
    } as IsolationRequest);

    const up = calls.sandbox.find(a => a[0] === 'up');
    expect(up?.[3]).toBe('develop');
  });

  test('rejects an explicit --from start point (sandbox.sh up cuts only from the base)', async () => {
    const { runSandbox, docker } = makeRunners();
    const provider = new ContainerProvider({ runSandbox, docker, loadConfig: async () => null });

    await expect(
      provider.create({
        ...BASE_REQ,
        workflowType: 'task',
        identifier: 't',
        fromBranch: 'feature-x',
      } as IsolationRequest)
    ).rejects.toThrow(/from|start.point/i);
  });

  test('rejects a PR checkout (sandbox.sh cannot check out a PR)', async () => {
    const { runSandbox, docker } = makeRunners();
    const provider = new ContainerProvider({ runSandbox, docker, loadConfig: async () => null });

    await expect(
      provider.create({
        ...BASE_REQ,
        workflowType: 'pr',
        identifier: '42',
        prBranch: 'pr-42',
        isForkPR: false,
      } as IsolationRequest)
    ).rejects.toThrow(/pr|pull request/i);
  });
});
