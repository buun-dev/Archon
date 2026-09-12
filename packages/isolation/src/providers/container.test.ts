import { describe, test, expect } from 'bun:test';
import { ContainerProvider, SANDBOX_COMPOSE_FILE } from './container';
import type { IsolationRequest } from '../types';
import { toBranchName } from '@archon/git';
import type { WslRunner } from '../backends/sandbox';

/**
 * Fake runners so create() is unit-testable without a real WSL distro / docker
 * daemon. `wsl` records every script the lifecycle runs inside the distro;
 * `docker` answers the `compose -p <project> ps -q agent` container-id resolution
 * and records every call; `probeWsl` answers the prerequisite preflight with the
 * distro up, its home reported, and the base clone present.
 *
 * `probeWsl` is not optional garnish: without it these tests fall through to
 * `defaultProbeWsl`, which really shells `wsl.exe -d Ubuntu` — so they would pass
 * on this machine and fail on any machine without the distro, while proving
 * nothing about the code either way.
 */
function makeRunners(containerId = 'container-abc') {
  const calls: { wsl: { script: string; env: Record<string, string> }[]; docker: string[][] } = {
    wsl: [],
    docker: [],
  };
  const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => ({
    stdout: 'ARCHON_WSL_OK\nARCHON_WSL_HOME=/home/u\nARCHON_BASE_CLONE_OK\n',
    stderr: '',
  });
  const wsl: WslRunner = async (_distro, script, opts) => {
    calls.wsl.push({ script, env: opts.env ?? {} });
    return { stdout: '', stderr: '' };
  };
  const docker = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    calls.docker.push(args);
    if (args.includes('ps')) return { stdout: `${containerId}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const loadRepoSandboxConfig = async (): Promise<{ compose?: string; provision?: string }> => ({
    compose: '.archon/sandbox.compose.yml',
    provision: 'python3 scripts/sandbox_env.py',
  });
  /** The lifecycle's `compose up` script, or undefined when `up` never ran. */
  const composeUp = (): { script: string; env: Record<string, string> } | undefined =>
    calls.wsl.find(c => c.script.includes('compose') && c.script.includes('up -d'));
  return {
    calls,
    wsl,
    docker,
    probeWsl,
    loadRepoSandboxConfig,
    composeUp,
    onLine: (): void => undefined,
    // Never the process env: a fresh worktree needs a token, and the machine's
    // must not be what makes these pass.
    secretsFrom: { GH_TOKEN: 'token-x', ANTHROPIC_API_KEY: 'key-x' },
  };
}

const BASE_REQ = {
  canonicalRepoPath: '/repo/marphob-page',
  codebaseId: 'cb1',
  codebaseName: 'owner/marphob-page',
  baseBranch: 'main',
} as const;

describe('ContainerProvider.create', () => {
  test('brings up the WSL sandbox and returns a container execContext', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

    const env = await provider.create({
      ...BASE_REQ,
      workflowType: 'task',
      identifier: 'my-task',
    } as IsolationRequest);

    // The lifecycle ran `compose up` for archon-<repo>-<slug>, in the distro.
    const up = runners.composeUp();
    expect(up?.script).toContain('-p archon-marphob-page-task-my-task');

    expect(env.provider).toBe('container');
    if (env.provider !== 'container') throw new Error('expected a container environment');
    expect(env.execContext.kind).toBe('container');
    expect(env.execContext.containerId).toBe('container-abc');
    expect(env.branchName).toBe(toBranchName('sandbox/task-my-task'));
    expect(env.project).toBe('archon-marphob-page-task-my-task');
    // The worktree root defaults to `~/archon/worktrees` under the PROBED distro home.
    expect(env.workingPath).toBe('/home/u/archon/worktrees/marphob-page/task-my-task');
    // Resolved base snapshotted for a fixed-base resume (PR#1).
    expect(env.baseBranch).toBe(toBranchName('main'));
  });

  test('resolves the container id via `docker compose -p <project> ps -q agent`', async () => {
    const runners = makeRunners('cid-xyz');
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

    const env = await provider.create({
      ...BASE_REQ,
      workflowType: 'task',
      identifier: 't',
    } as IsolationRequest);

    const ps = runners.calls.docker.find(a => a.includes('ps'));
    expect(ps).toContain('-p');
    expect(ps).toContain('archon-marphob-page-task-t');
    expect(ps).toContain('agent');
    if (env.provider !== 'container') throw new Error('expected a container environment');
    expect(env.execContext.containerId).toBe('cid-xyz');
  });

  test('base precedence: baseOverride wins over repo config and request.baseBranch', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({
      ...runners,
      loadConfig: async () => ({ baseBranch: 'develop' }),
    });

    await provider.create({
      ...BASE_REQ,
      workflowType: 'task',
      identifier: 't',
      baseBranch: 'main',
      baseOverride: 'release',
    } as IsolationRequest);

    const add = runners.calls.wsl.find(c => c.script.includes('worktree add'));
    expect(add?.script).toContain('origin/release');
  });

  test('base precedence: repo config wins over request.baseBranch when no override', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({
      ...runners,
      loadConfig: async () => ({ baseBranch: 'develop' }),
    });

    await provider.create({
      ...BASE_REQ,
      workflowType: 'task',
      identifier: 't',
      baseBranch: 'main',
    } as IsolationRequest);

    const add = runners.calls.wsl.find(c => c.script.includes('worktree add'));
    expect(add?.script).toContain('origin/develop');
  });

  test('rejects an explicit --from start point (the sandbox cuts only from the base)', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

    await expect(
      provider.create({
        ...BASE_REQ,
        workflowType: 'task',
        identifier: 't',
        taskBranch: { kind: 'new', fromBranch: toBranchName('feature-x') },
      } as IsolationRequest)
    ).rejects.toThrow(/from|start.point/i);
  });

  test('rejects a PR checkout (the sandbox cannot check out a PR)', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

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

/**
 * Slice 2 of the lifecycle design — what the provider hands the lifecycle is
 * assembled from three sources: the machine (global `isolation.container`, with
 * defaults resolved against the probed distro home), the repo (its `isolation`
 * section), and Archon's own base compose file.
 */
describe('ContainerProvider.create — the spec the lifecycle receives', () => {
  const REQ = { ...BASE_REQ, workflowType: 'task', identifier: 'spec' } as IsolationRequest;

  test("compose gets Archon's base file as a distro path, then the repo overlay inside the worktree", async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

    await provider.create(REQ);

    const up = runners.composeUp()!;
    // `import.meta.dir`-relative on the host; the distro sees it under /mnt/<drive>.
    expect(SANDBOX_COMPOSE_FILE.replace(/\\/g, '/')).toMatch(
      /packages\/isolation\/docker\/sandbox\.compose\.yml$/
    );
    const baseInDistro = /^[A-Za-z]:/.test(SANDBOX_COMPOSE_FILE)
      ? `/mnt/${SANDBOX_COMPOSE_FILE[0].toLowerCase()}/${SANDBOX_COMPOSE_FILE.slice(3).replace(/\\/g, '/')}`
      : SANDBOX_COMPOSE_FILE;
    expect(up.script).toContain(
      `-f ${baseInDistro} -f /home/u/archon/worktrees/marphob-page/task-spec/.archon/sandbox.compose.yml`
    );
    expect(up.env.ARCHON_RUNNER_IMAGE).toBe('archon-runner:latest');
    expect(up.env.ARCHON_WORKTREE).toBe('/home/u/archon/worktrees/marphob-page/task-spec');
    expect(up.env.ARCHON_BASE_CLONE).toBe('/home/u/archon/repos/marphob-page');
    // The run's project dir, as the engine resolves it, distro-visible.
    expect(up.env.ARCHON_META_DIR).toMatch(/\.archon\/workspaces\/owner\/marphob-page$/);
  });

  test("the repo's provision command is the one command run in the container", async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

    await provider.create(REQ);

    const exec = runners.calls.docker.find(a => a.includes('exec') && !a.includes('--user'));
    expect(exec).toEqual([
      'compose',
      '-p',
      'archon-marphob-page-task-spec',
      'exec',
      '-T',
      'agent',
      'bash',
      '-lc',
      'python3 scripts/sandbox_env.py',
    ]);
  });

  test('a repo with no `isolation.provision` is refused before any probe, naming the setting', async () => {
    const runners = makeRunners();
    let probes = 0;
    const provider = new ContainerProvider({
      ...runners,
      probeWsl: async () => {
        probes += 1;
        return {
          stdout: 'ARCHON_WSL_OK\nARCHON_WSL_HOME=/home/u\nARCHON_BASE_CLONE_OK\n',
          stderr: '',
        };
      },
      loadRepoSandboxConfig: async () => ({ compose: '.archon/sandbox.compose.yml' }),
      loadConfig: async () => null,
    });

    await expect(provider.create(REQ)).rejects.toThrow(/isolation\.provision/);
    expect(probes).toBe(0);
    expect(runners.calls.wsl).toHaveLength(0);
  });

  test('no overlay configured: compose gets the base file alone', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({
      ...runners,
      loadRepoSandboxConfig: async () => ({ provision: 'make sandbox' }),
      loadConfig: async () => null,
    });

    await provider.create(REQ);

    const up = runners.composeUp()!;
    expect(up.script).not.toContain('.archon/sandbox.compose.yml');
    expect(up.script.match(/ -f /g)).toHaveLength(1);
    expect(up.script).toMatch(/-f \S+\/docker\/sandbox\.compose\.yml up -d --wait/);
  });

  test('global `isolation.container` values reach the lifecycle; `~` roots resolve against the probed home', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({
      ...runners,
      loadHostConfig: async () => ({
        distro: 'Debian',
        image: 'runner:pinned',
        repoRoot: '~/clones',
        worktreeRoot: '/srv/wt',
        gitIdentity: { email: 'bot@example.com', name: 'Bot' },
      }),
      loadConfig: async () => null,
    });

    const env = await provider.create(REQ);

    expect(env.workingPath).toBe('/srv/wt/marphob-page/task-spec');
    const up = runners.composeUp()!;
    expect(up.env.ARCHON_RUNNER_IMAGE).toBe('runner:pinned');
    expect(up.env.ARCHON_BASE_CLONE).toBe('/home/u/clones/marphob-page');
    const stamp = runners.calls.wsl.find(c => c.script.includes('user.email'));
    expect(stamp?.script).toContain('config --worktree user.email bot@example.com');
  });

  test("the dispatch's own identity wins over the configured fallback", async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({
      ...runners,
      loadHostConfig: async () => ({ gitIdentity: { email: 'bot@example.com' } }),
      loadConfig: async () => null,
    });

    await provider.create({ ...REQ, gitIdentity: { email: 'human@example.com', name: 'Human' } });

    const stamp = runners.calls.wsl.find(c => c.script.includes('user.email'));
    expect(stamp?.script).toContain('user.email human@example.com');
    expect(stamp?.script).not.toContain('bot@example.com');
  });
});

describe('ContainerProvider.writeBackBackend (engine port)', () => {
  test('suspend stops the agent for the BOUND working path, ignoring the row id it is handed', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

    const port = provider.writeBackBackend('/home/bunny/archon/worktrees/marphob-page/task-x');
    // The engine passes an `isolation_environments` row id here, never a path (D5).
    await port.suspend('env-row-01H8XYZ');

    const stop = runners.calls.docker.find(a => a.includes('stop'));
    expect(stop).toContain('-p');
    expect(stop).toContain('archon-marphob-page-task-x');
    expect(stop).toContain('agent');
    // The row id must never reach the compose project name.
    expect(stop?.join(' ')).not.toContain('env-row-01H8XYZ');
  });

  test('finalize never requests approval — a repo run is already commits on its branch', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

    const port = provider.writeBackBackend('/home/bunny/archon/worktrees/marphob-page/task-x');

    expect(await port.finalize('env-row-01H8XYZ')).toEqual({ requiresApproval: false });
    await expect(port.applyChanges('env-row-01H8XYZ')).rejects.toThrow(/no overlay write-back/);
    await expect(port.discardChanges('env-row-01H8XYZ')).rejects.toThrow(/no overlay write-back/);
  });
});

describe('ContainerProvider.reattach (resume / D8 recovery)', () => {
  test('restarts the agent then rebuilds the execContext from a working path', async () => {
    const runners = makeRunners('cid-resumed');
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

    const env = await provider.reattach('/home/bunny/archon/worktrees/marphob-page/task-x');

    // The container may be stopped after a kill/docker-restart, so `start` runs
    // BEFORE the id is resolved (D8).
    const started = runners.calls.docker.find(a => a.includes('start'));
    expect(started).toContain('archon-marphob-page-task-x');
    expect(started).toContain('agent');

    expect(env.provider).toBe('container');
    if (env.provider !== 'container') throw new Error('expected a container environment');
    expect(env.execContext.containerId).toBe('cid-resumed');
    expect(env.project).toBe('archon-marphob-page-task-x');
    expect(env.branchName).toBe(toBranchName('sandbox/task-x'));
    // reattach must NOT re-run the lifecycle (no re-provision on resume).
    expect(runners.calls.wsl).toHaveLength(0);
  });
});

describe('ContainerProvider.destroy', () => {
  test('composes the stack down and removes the worktree in the distro, addressed by the working path', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

    await provider.destroy('/home/u/archon/worktrees/marphob-page/task-x');

    expect(runners.calls.docker).toContainEqual([
      'compose',
      '-p',
      'archon-marphob-page-task-x',
      'down',
      '-v',
    ]);
    const script = runners.calls.wsl.map(c => c.script).join('\n');
    expect(script).toContain(
      'git -C /home/u/archon/repos/marphob-page worktree remove --force /home/u/archon/worktrees/marphob-page/task-x'
    );
    expect(script).toContain('branch -D sandbox/task-x');
  });

  test('an unreachable distro is swallowed — the run is already over', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({
      ...runners,
      probeWsl: async () => {
        throw new Error('no distro');
      },
      loadConfig: async () => null,
    });

    const result = await provider.destroy('/home/u/archon/worktrees/marphob-page/task-x');
    expect(result.worktreeRemoved).toBe(true);
  });
});

describe('ContainerProvider — execution context shape', () => {
  // Same-path mounting removes the reason workdir and pathMap existed. Upstream's
  // container context has neither, and this asserts the fork's matches: the whole
  // point of the change is that the two stop diverging.
  test('carries no workdir and no pathMap', async () => {
    const runners = makeRunners();
    const provider = new ContainerProvider({ ...runners, loadConfig: async () => null });

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
 * A repo-kind container run's prerequisites live entirely outside the repo: the
 * distro, the repo's base clone inside it, Archon's own base compose file, a
 * reachable Docker daemon, and the runner image compose brings up. Each is
 * checked BEFORE the lifecycle creates anything.
 *
 * Every test here asserts the SPY, not just the rejection: a fake that resolves
 * everything would let `create()` reject for some later reason and prove nothing
 * about ordering. `calls.wsl` being empty is the ordering claim.
 */
describe('ContainerProvider.create — prerequisite preflight', () => {
  const REQ = { ...BASE_REQ, workflowType: 'task', identifier: 'pre' } as IsolationRequest;

  test('refuses before the lifecycle when the WSL distro is unreachable', async () => {
    const runners = makeRunners();
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => {
      const err = new Error('Command failed') as Error & { stderr?: string };
      err.stderr = 'There is no distribution with the supplied name.';
      throw err;
    };
    const provider = new ContainerProvider({ ...runners, probeWsl, loadConfig: async () => null });

    await expect(provider.create(REQ)).rejects.toThrow(/WSL distro 'Ubuntu'/);
    expect(runners.calls.wsl).toHaveLength(0);
  });

  test('refuses before the lifecycle when the base clone is missing, naming where it goes', async () => {
    const runners = makeRunners();
    // The distro answers; the repo has never been cloned into it.
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: 'ARCHON_WSL_OK\nARCHON_WSL_HOME=/home/u\n',
      stderr: '',
    });
    const provider = new ContainerProvider({ ...runners, probeWsl, loadConfig: async () => null });

    const p = provider.create(REQ);
    await expect(p).rejects.toThrow(/base clone/);
    await expect(p).rejects.toThrow(/\/home\/u\/archon\/repos\/marphob-page/);
    await expect(p).rejects.toThrow(/git clone/);
    expect(runners.calls.wsl).toHaveLength(0);
  });

  test('the probed distro is the CONFIGURED one', async () => {
    const runners = makeRunners();
    let probed: string | undefined;
    const provider = new ContainerProvider({
      ...runners,
      probeWsl: async (distro: string) => {
        probed = distro;
        const err = new Error('Command failed') as Error & { stderr?: string };
        err.stderr = 'There is no distribution with the supplied name.';
        throw err;
      },
      loadHostConfig: async () => ({ distro: 'Fedora' }),
      loadConfig: async () => null,
    });

    await expect(provider.create(REQ)).rejects.toThrow(/WSL distro 'Fedora'/);
    expect(probed).toBe('Fedora');
  });

  test('refuses before the lifecycle when the Docker daemon is unreachable', async () => {
    const runners = makeRunners();
    const docker = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === 'version') {
        const err = new Error('Command failed') as Error & { stderr?: string };
        err.stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock';
        throw err;
      }
      return { stdout: '', stderr: '' };
    };
    const provider = new ContainerProvider({ ...runners, docker, loadConfig: async () => null });

    await expect(provider.create(REQ)).rejects.toThrow(/Docker daemon/);
    expect(runners.calls.wsl).toHaveLength(0);
  });

  test('refuses before the lifecycle when the runner image is absent, naming how to build it and the config key', async () => {
    const runners = makeRunners();
    const docker = async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
      if (args[0] === 'image') {
        const err = new Error('Command failed') as Error & { stderr?: string };
        err.stderr = 'Error: No such image: archon-runner:latest';
        throw err;
      }
      return { stdout: '', stderr: '' };
    };
    const provider = new ContainerProvider({ ...runners, docker, loadConfig: async () => null });

    const p = provider.create(REQ);
    await expect(p).rejects.toThrow(/archon-runner:latest/);
    // Naming the symptom is not enough — name the command that fixes it, and the key.
    await expect(p).rejects.toThrow(/build-runner\.sh/);
    await expect(p).rejects.toThrow(/isolation\.container\.image/);
    expect(runners.calls.wsl).toHaveLength(0);
  });

  // `wsl.exe` writes UTF-16LE, which reaches us as an EMPTY stderr, so the fallback
  // detail is `Command failed: wsl.exe -d Ubuntu … <the whole probe script>`.
  // Echoing our own script back at the operator buries the sentence that helps.
  test('the distro refusal does not echo the probe script back at the operator', async () => {
    const runners = makeRunners();
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => {
      const err = new Error(
        'Command failed: wsl.exe -d Ubuntu --exec bash -c echo ARCHON_WSL_OK; echo "ARCHON_WSL_HOME=$HOME"; if [ -d \'/x\' ]; then echo ARCHON_BASE_CLONE_OK; fi'
      ) as Error & { stderr?: string; code?: string };
      err.stderr = '';
      err.code = 'ENOENT';
      throw err;
    };
    const provider = new ContainerProvider({ ...runners, probeWsl, loadConfig: async () => null });

    const message = await provider.create(REQ).then(
      () => 'resolved',
      (e: Error) => e.message
    );
    expect(message).toContain("WSL distro 'Ubuntu' is not reachable");
    expect(message).toContain('ENOENT');
    expect(message).not.toContain('ARCHON_WSL_OK');
  });

  test('every refusal names the setting the operator must correct', async () => {
    const runners = makeRunners();
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => ({
      stdout: '',
      stderr: '',
    });
    const provider = new ContainerProvider({ ...runners, probeWsl, loadConfig: async () => null });

    await expect(provider.create(REQ)).rejects.toThrow(/isolation\.provider/);
  });

  test('a satisfied prerequisite set costs one WSL probe, then provisions', async () => {
    const runners = makeRunners();
    let probes = 0;
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => {
      probes += 1;
      return {
        stdout: 'ARCHON_WSL_OK\nARCHON_WSL_HOME=/home/u\nARCHON_BASE_CLONE_OK\n',
        stderr: '',
      };
    };
    const provider = new ContainerProvider({ ...runners, probeWsl, loadConfig: async () => null });

    await provider.create(REQ);

    expect(probes).toBe(1);
    // The preflight's docker cost is the daemon + image pair, nothing heavier.
    expect(runners.calls.docker.filter(a => a[0] === 'version')).toHaveLength(1);
    expect(runners.calls.docker.filter(a => a[0] === 'image')).toHaveLength(1);
    expect(runners.composeUp()).toBeDefined();
  });

  test('a rejected REQUEST never reaches the environment probe', async () => {
    const runners = makeRunners();
    let probes = 0;
    const probeWsl = async (): Promise<{ stdout: string; stderr: string }> => {
      probes += 1;
      return {
        stdout: 'ARCHON_WSL_OK\nARCHON_WSL_HOME=/home/u\nARCHON_BASE_CLONE_OK\n',
        stderr: '',
      };
    };
    const provider = new ContainerProvider({ ...runners, probeWsl, loadConfig: async () => null });

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
