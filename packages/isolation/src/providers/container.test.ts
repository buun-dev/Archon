import { describe, test, expect } from 'bun:test';
import { ContainerProvider } from './container';
import type { IsolationRequest } from '../types';
import { toBranchName } from '@archon/git';

/**
 * Fake runners so create() is unit-testable without a real WSL distro / docker
 * daemon. `runSandbox` records every `sandbox.sh` invocation; `docker` answers
 * the `compose -p <project> ps -q agent` container-id resolution; `probeWsl`
 * answers the slice-4 prerequisite preflight with both markers present.
 *
 * `probeWsl` is not optional garnish: without it these tests fall through to
 * `defaultProbeWsl`, which really shells `wsl.exe -d Ubuntu` — so they would pass
 * on this machine and fail on any machine without the distro, while proving
 * nothing about the code either way.
 */
function makeRunners(containerId = 'container-abc') {
  const calls: { sandbox: string[][]; docker: string[][] } = { sandbox: [], docker: [] };
  const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => ({
    stdout: 'ARCHON_WSL_OK\nARCHON_SANDBOX_SH_OK\n',
    stderr: '',
  });
  const runSandbox = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.sandbox.push(args);
    return { stdout: '', stderr: '' };
  };
  const docker = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.docker.push(args);
    if (args.includes('ps')) return { stdout: `${containerId}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { calls, runSandbox, docker, probeWsl };
}

const BASE_REQ = {
  canonicalRepoPath: '/repo/marphob-page',
  codebaseId: 'cb1',
  codebaseName: 'marphob-page',
  baseBranch: 'main',
} as const;

describe('ContainerProvider.create', () => {
  test('brings up the WSL sandbox and returns a container execContext', async () => {
    const { calls, runSandbox, docker, probeWsl } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

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
    expect(env.branchName).toBe(toBranchName('sandbox/task-my-task'));
    expect(env.project).toBe('archon-marphob-page-task-my-task');
    // Resolved base snapshotted for a fixed-base resume (PR#1).
    expect(env.baseBranch).toBe(toBranchName('main'));
  });

  test('resolves the container id via `docker compose -p <project> ps -q agent`', async () => {
    const { calls, runSandbox, docker, probeWsl } = makeRunners('cid-xyz');
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

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
    const { calls, runSandbox, docker, probeWsl } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
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
    const { calls, runSandbox, docker, probeWsl } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
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
    const { runSandbox, docker, probeWsl } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    await expect(
      provider.create({
        ...BASE_REQ,
        workflowType: 'task',
        identifier: 't',
        taskBranch: { kind: 'new', fromBranch: toBranchName('feature-x') },
      } as IsolationRequest)
    ).rejects.toThrow(/from|start.point/i);
  });

  test('rejects a PR checkout (sandbox.sh cannot check out a PR)', async () => {
    const { runSandbox, docker, probeWsl } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

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

describe('ContainerProvider.writeBackBackend (engine port)', () => {
  test('suspend stops the agent for the BOUND working path, ignoring the row id it is handed', async () => {
    const { calls, runSandbox, docker, probeWsl } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    const port = provider.writeBackBackend('/home/bunny/archon/worktrees/marphob-page/task-x');
    // The engine passes an `isolation_environments` row id here, never a path (D5).
    await port.suspend('env-row-01H8XYZ');

    const stop = calls.docker.find(a => a.includes('stop'));
    expect(stop).toContain('-p');
    expect(stop).toContain('archon-marphob-page-task-x');
    expect(stop).toContain('agent');
    // The row id must never reach the compose project name.
    expect(stop?.join(' ')).not.toContain('env-row-01H8XYZ');
  });

  test('finalize never requests approval — a repo run is already commits on its branch', async () => {
    const { runSandbox, docker, probeWsl } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    const port = provider.writeBackBackend('/home/bunny/archon/worktrees/marphob-page/task-x');

    expect(await port.finalize('env-row-01H8XYZ')).toEqual({ requiresApproval: false });
    await expect(port.applyChanges('env-row-01H8XYZ')).rejects.toThrow(/no overlay write-back/);
    await expect(port.discardChanges('env-row-01H8XYZ')).rejects.toThrow(/no overlay write-back/);
  });
});

describe('ContainerProvider.reattach (resume / D8 recovery)', () => {
  test('restarts the agent then rebuilds the execContext from a working path', async () => {
    const { calls, runSandbox, docker, probeWsl } = makeRunners('cid-resumed');
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    const env = await provider.reattach('/home/bunny/archon/worktrees/marphob-page/task-x');

    // The container may be stopped after a kill/docker-restart, so `start` runs
    // BEFORE the id is resolved (D8).
    const started = calls.docker.find(a => a.includes('start'));
    expect(started).toContain('archon-marphob-page-task-x');
    expect(started).toContain('agent');

    expect(env.provider).toBe('container');
    if (env.provider !== 'container') throw new Error('expected a container environment');
    expect(env.execContext.containerId).toBe('cid-resumed');
    expect(env.project).toBe('archon-marphob-page-task-x');
    expect(env.branchName).toBe(toBranchName('sandbox/task-x'));
    // reattach must NOT re-run the sandbox `up` (no re-provision on resume).
    expect(calls.sandbox.find(a => a[0] === 'up')).toBeUndefined();
  });
});

describe('ContainerProvider — execution context shape', () => {
  // Same-path mounting removes the reason workdir and pathMap existed. Upstream's
  // container context has neither, and this asserts the fork's matches: the whole
  // point of the change is that the two stop diverging.
  test('carries no workdir and no pathMap', async () => {
    const { runSandbox, docker, probeWsl } = makeRunners();
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    const env = await provider.create({
      ...BASE_REQ,
      workflowType: 'task',
      identifier: 'shape-check',
    } as IsolationRequest);

    expect(env.provider).toBe('container');
    if (env.provider !== 'container') throw new Error('expected a container environment');
    expect(env.execContext.kind).toBe('container');
    expect(Object.keys(env.execContext).sort()).toEqual(['containerId', 'execUser', 'kind']);
  });
});

/**
 * Slice 4 — a repo-kind container run's prerequisites live entirely outside the
 * repo: the `sandbox.sh` lifecycle script, the Ubuntu distro it runs in, a
 * reachable Docker daemon, and the runner image compose brings up. None of them
 * was checked; each surfaced as vendor stderr from `wsl.exe` or `docker`, after
 * the 20-minute `sandbox.sh up` had already started creating things.
 *
 * Every test here asserts the SPY, not just the rejection: a fake that resolves
 * everything would let `create()` reject for some later reason and prove nothing
 * about ordering. `calls.sandbox` being empty is the ordering claim.
 */
describe('ContainerProvider.create — prerequisite preflight', () => {
  const REQ = { ...BASE_REQ, workflowType: 'task', identifier: 'pre' } as IsolationRequest;

  test('refuses before sandbox.sh up when the WSL distro is unreachable', async () => {
    const { calls, runSandbox, docker } = makeRunners();
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => {
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'There is no distribution with the supplied name.';
      throw err;
    };
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    await expect(provider.create(REQ)).rejects.toThrow(/WSL distro 'Ubuntu'/);
    expect(calls.sandbox).toHaveLength(0);
  });

  test('refuses before sandbox.sh up when the lifecycle script is missing', async () => {
    const { calls, runSandbox, docker } = makeRunners();
    // The distro answers; the script is not on its filesystem.
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: 'ARCHON_WSL_OK\n',
      stderr: '',
    });
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    await expect(provider.create(REQ)).rejects.toThrow(/sandbox\.sh/);
    expect(calls.sandbox).toHaveLength(0);
  });

  test('refuses before sandbox.sh up when the Docker daemon is unreachable', async () => {
    const { calls, runSandbox } = makeRunners();
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: 'ARCHON_WSL_OK\nARCHON_SANDBOX_SH_OK\n',
      stderr: '',
    });
    const docker = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === 'version') {
        const err = new Error('Command failed') as Error & { stderr?: string };
        err.stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
        throw err;
      }
      return { stdout: '', stderr: '' };
    };
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    await expect(provider.create(REQ)).rejects.toThrow(/Docker daemon/);
    expect(calls.sandbox).toHaveLength(0);
  });

  test('refuses before sandbox.sh up when the runner image is absent, naming how to build it', async () => {
    const { calls, runSandbox } = makeRunners();
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: 'ARCHON_WSL_OK\nARCHON_SANDBOX_SH_OK\n',
      stderr: '',
    });
    const docker = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === 'image') {
        const err = new Error('Command failed') as Error & { stderr?: string };
        err.stderr = 'Error: No such image: archon-runner:latest';
        throw err;
      }
      return { stdout: '', stderr: '' };
    };
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    const p = provider.create(REQ);
    await expect(p).rejects.toThrow(/archon-runner:latest/);
    // Naming the symptom is not enough — name the command that fixes it.
    await expect(p).rejects.toThrow(/build-runner\.sh/);
    expect(calls.sandbox).toHaveLength(0);
  });

  // `wsl.exe` writes UTF-16LE, which reaches us as an EMPTY stderr, so the fallback
  // detail is `Command failed: wsl.exe -d Ubuntu -- bash -c <the whole probe script>`.
  // Echoing our own script back at the operator buries the sentence that helps.
  test('the distro refusal does not echo the probe script back at the operator', async () => {
    const { runSandbox, docker } = makeRunners();
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => {
      const err = new Error(
        "Command failed: wsl.exe -d Ubuntu -- bash -c echo ARCHON_WSL_OK; if [ -f '/x' ]; then echo ARCHON_SANDBOX_SH_OK; fi"
      ) as Error & { stderr?: string; code?: string };
      err.stderr = '';
      err.code = 'ENOENT';
      throw err;
    };
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    const message = await provider.create(REQ).then(
      () => 'resolved',
      (e: Error) => e.message
    );
    expect(message).toContain("WSL distro 'Ubuntu' is not reachable");
    expect(message).toContain('ENOENT');
    expect(message).not.toContain('ARCHON_WSL_OK');
  });

  test('every refusal names the setting the operator must correct', async () => {
    const { runSandbox, docker } = makeRunners();
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: '',
      stderr: '',
    });
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    await expect(provider.create(REQ)).rejects.toThrow(/isolation\.provider/);
  });

  test('a satisfied prerequisite set costs one WSL probe, then provisions', async () => {
    const { calls, runSandbox, docker } = makeRunners();
    let probes = 0;
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => {
      probes += 1;
      return { stdout: 'ARCHON_WSL_OK\nARCHON_SANDBOX_SH_OK\n', stderr: '' };
    };
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    await provider.create(REQ);

    expect(probes).toBe(1);
    // The preflight's docker cost is the daemon + image pair, nothing heavier.
    expect(calls.docker.filter(a => a[0] === 'version')).toHaveLength(1);
    expect(calls.docker.filter(a => a[0] === 'image')).toHaveLength(1);
    expect(calls.sandbox.find(a => a[0] === 'up')).toBeDefined();
  });

  test('a rejected REQUEST never reaches the environment probe', async () => {
    const { runSandbox, docker } = makeRunners();
    let probes = 0;
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => {
      probes += 1;
      return { stdout: 'ARCHON_WSL_OK\nARCHON_SANDBOX_SH_OK\n', stderr: '' };
    };
    const provider = new ContainerProvider({
      runSandbox,
      docker,
      probeWsl,
      loadConfig: async () => null,
    });

    await expect(
      provider.create({
        ...BASE_REQ,
        workflowType: 'task',
        identifier: 't',
        taskBranch: { kind: 'new', fromBranch: toBranchName('feature-x') },
      } as IsolationRequest)
    ).rejects.toThrow(/start point/i);
    expect(probes).toBe(0);
  });
});
