import { describe, test, expect } from 'bun:test';
import {
  SandboxLifecycle,
  resolveSandboxHost,
  SANDBOX_HOST_DEFAULTS,
  type SandboxUpSpec,
  type WslRunner,
  type SandboxDockerRunner,
} from './sandbox';

/**
 * Fake runners. `wsl` records every script run inside the distro and answers the
 * worktree-existence probe from `worktreeExists`; `docker` records every Windows
 * docker CLI invocation. Neither touches a process.
 */
function makeRunners(opts: { worktreeExists?: boolean; provisionLines?: string[] } = {}) {
  const calls: { wsl: { script: string; env: Record<string, string> }[]; docker: string[][] } = {
    wsl: [],
    docker: [],
  };
  const lines: string[] = [];
  const wsl: WslRunner = async (_distro, script, runOpts) => {
    calls.wsl.push({ script, env: runOpts.env ?? {} });
    if (script.includes('ARCHON_WORKTREE_EXISTS')) {
      return { stdout: opts.worktreeExists ? 'ARCHON_WORKTREE_EXISTS\n' : '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const docker: SandboxDockerRunner = async (args, runOpts) => {
    calls.docker.push(args);
    if (args.includes('exec') && !args.includes('--user')) {
      for (const line of opts.provisionLines ?? []) runOpts.onLine?.(line);
    }
    return { stdout: '', stderr: '' };
  };
  return { calls, lines, wsl, docker, onLine: (l: string) => lines.push(l) };
}

const SPEC: SandboxUpSpec = {
  distro: 'Ubuntu',
  project: 'archon-bunshee-task-x',
  repo: 'bunshee',
  slug: 'task-x',
  baseBranch: 'master',
  baseClone: '/home/u/archon/repos/bunshee',
  worktree: '/home/u/archon/worktrees/bunshee/task-x',
  image: 'archon-runner:latest',
  composeBase: '/mnt/d/archon/packages/isolation/docker/sandbox.compose.yml',
  composeOverlay: '/home/u/archon/worktrees/bunshee/task-x/.archon/sandbox.compose.yml',
  provision: 'python3 scripts/sandbox_env.py',
  scriptsDir: '/mnt/c/Users/me/.archon/scripts',
  metaDir: '/mnt/c/Users/me/.archon/workspaces/o/bunshee',
  secrets: { GH_TOKEN: 'token-x', ANTHROPIC_API_KEY: 'key-x' },
};

describe('resolveSandboxHost', () => {
  test('an empty config resolves to the original layout under the distro home', () => {
    const host = resolveSandboxHost(undefined, '/home/bunny');
    expect(host).toEqual({
      distro: SANDBOX_HOST_DEFAULTS.distro,
      image: SANDBOX_HOST_DEFAULTS.image,
      repoRoot: '/home/bunny/archon/repos',
      worktreeRoot: '/home/bunny/archon/worktrees',
      gitIdentity: undefined,
    });
  });

  test('configured values win and a leading ~ is the distro home', () => {
    const host = resolveSandboxHost(
      { distro: 'Debian', image: 'runner:1', repoRoot: '~/src', worktreeRoot: '/srv/wt' },
      '/home/x'
    );
    expect(host.distro).toBe('Debian');
    expect(host.image).toBe('runner:1');
    expect(host.repoRoot).toBe('/home/x/src');
    expect(host.worktreeRoot).toBe('/srv/wt');
  });
});

describe('SandboxLifecycle.up', () => {
  test('a fresh worktree: fetch with the token, worktree add, handshake, compose up, provision, firewall — in that order', async () => {
    const { calls, lines, wsl, docker, onLine } = makeRunners({
      provisionLines: ['[sandbox_env] == uv sync ==', '[sandbox_env] == env-gen =='],
    });
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await lifecycle.up(SPEC);

    const scripts = calls.wsl.map(c => c.script);
    const idx = (needle: string): number => scripts.findIndex(s => s.includes(needle));
    expect(idx('ARCHON_WORKTREE_EXISTS')).toBe(0);
    expect(idx('fetch')).toBeGreaterThan(idx('ARCHON_WORKTREE_EXISTS'));
    expect(idx('worktree add')).toBeGreaterThan(idx('fetch'));
    expect(idx('.worktree-ports.json')).toBeGreaterThan(idx('worktree add'));
    expect(idx('compose')).toBeGreaterThan(idx('.worktree-ports.json'));

    // The fetch authenticates with the forwarded token, not the distro's credentials.
    const fetch = calls.wsl[idx('fetch')];
    expect(fetch.script).toContain('x-access-token');
    expect(fetch.env.GH_TOKEN).toBe('token-x');
    expect(fetch.script).toContain('+refs/heads/master:refs/remotes/origin/master');
    expect(scripts[idx('worktree add')]).toContain('-b sandbox/task-x');
    expect(scripts[idx('worktree add')]).toContain('origin/master');

    // compose up carries base THEN overlay, and the mounts' env, inside the distro.
    const compose = calls.wsl[idx('compose')];
    expect(compose.script).toContain(`-f ${SPEC.composeBase} -f ${SPEC.composeOverlay}`);
    expect(compose.script).toContain(`-p ${SPEC.project}`);
    expect(compose.script).toContain('up -d --wait');
    expect(compose.env).toMatchObject({
      ARCHON_RUNNER_IMAGE: 'archon-runner:latest',
      ARCHON_WORKTREE: SPEC.worktree,
      ARCHON_BASE_CLONE: SPEC.baseClone,
      ARCHON_SCRIPTS: SPEC.scriptsDir,
      ARCHON_META_DIR: SPEC.metaDir,
      GH_TOKEN: 'token-x',
      ANTHROPIC_API_KEY: 'key-x',
    });

    // Provisioning is the repo's one command; the firewall follows it (D6) as root.
    const execs = calls.docker.filter(a => a.includes('exec'));
    expect(execs).toHaveLength(2);
    expect(execs[0]).toEqual([
      'compose',
      '-p',
      SPEC.project,
      'exec',
      '-T',
      'agent',
      'bash',
      '-lc',
      'python3 scripts/sandbox_env.py',
    ]);
    expect(execs[1].slice(0, 7)).toEqual([
      'compose',
      '-p',
      SPEC.project,
      'exec',
      '-T',
      '--user',
      'root',
    ]);
    expect(execs[1].join(' ')).toContain('init-firewall.sh /etc/archon/allowlist.txt');

    // The entrypoint's own markers surface through the sink.
    expect(lines).toContain('[sandbox_env] == uv sync ==');
  });

  test('an existing worktree is re-used without a fetch, a worktree add, or a token', async () => {
    const { calls, wsl, docker, onLine } = makeRunners({ worktreeExists: true });
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await lifecycle.up({ ...SPEC, secrets: {} });

    const scripts = calls.wsl.map(c => c.script).join('\n');
    expect(scripts).not.toContain('fetch');
    expect(scripts).not.toContain('worktree add');
    expect(scripts).toContain('compose');
  });

  test('a fresh worktree with no GH_TOKEN is refused before anything is created', async () => {
    const { calls, wsl, docker, onLine } = makeRunners();
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await expect(lifecycle.up({ ...SPEC, secrets: {} })).rejects.toThrow(/GH_TOKEN/);
    expect(calls.wsl.map(c => c.script).join('\n')).not.toContain('worktree add');
    expect(calls.docker).toHaveLength(0);
  });

  test('the handshake carries slug, the fixed ports and db_host — and no db_name (D3)', async () => {
    const { calls, wsl, docker, onLine } = makeRunners();
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await lifecycle.up(SPEC);

    const script = calls.wsl.map(c => c.script).find(s => s.includes('.worktree-ports.json'))!;
    const json = /\n(\{[\s\S]*\})\n/.exec(script)?.[1];
    expect(json).toBeDefined();
    const handshake = JSON.parse(json!) as Record<string, unknown>;
    expect(handshake).toEqual({
      slug: 'task-x',
      frontend_port: 3000,
      backend_port: 8123,
      db_port: 5432,
      db_host: 'db',
      offset: null,
    });
    expect(script).toContain(`${SPEC.worktree}/.worktree-ports.json`);
  });

  test('a dispatch identity is stamped on the worktree, not the base clone', async () => {
    const { calls, wsl, docker, onLine } = makeRunners();
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await lifecycle.up({ ...SPEC, gitIdentity: { email: 'a@b.c', name: 'A B' } });

    const stamp = calls.wsl.map(c => c.script).find(s => s.includes('user.email'))!;
    expect(stamp).toContain(`git -C ${SPEC.worktree} config --worktree user.email a@b.c`);
    expect(stamp).toContain(`config --worktree user.name 'A B'`);
    expect(stamp).toContain(`git -C ${SPEC.baseClone} config extensions.worktreeConfig true`);
    expect(stamp).not.toContain(`git -C ${SPEC.baseClone} config user.email`);
  });

  test('no identity anywhere: nothing is stamped', async () => {
    const { calls, wsl, docker, onLine } = makeRunners();
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await lifecycle.up(SPEC);

    expect(calls.wsl.map(c => c.script).join('\n')).not.toContain('user.email');
  });

  test('no overlay: compose gets the base file alone', async () => {
    const { calls, wsl, docker, onLine } = makeRunners();
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await lifecycle.up({ ...SPEC, composeOverlay: undefined });

    const compose = calls.wsl.map(c => c.script).find(s => s.includes('compose'))!;
    expect(compose).toContain(`-f ${SPEC.composeBase} up`);
    expect(compose).not.toContain('.archon/sandbox.compose.yml');
  });

  test('a failing provision command fails `up` and names the step', async () => {
    const { wsl, onLine } = makeRunners();
    const docker: SandboxDockerRunner = async args => {
      if (args.includes('exec')) {
        const err = new Error('Command failed') as Error & { stderr?: string; code?: number };
        err.stderr = '[sandbox_env] FATAL: alembic failed';
        err.code = 1;
        throw err;
      }
      return { stdout: '', stderr: '' };
    };
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await expect(lifecycle.up(SPEC)).rejects.toThrow(/provision.*alembic failed/s);
  });
});

describe('SandboxLifecycle.down', () => {
  test('composes the stack down with its volumes, then removes the worktree and its branch in the distro', async () => {
    const { calls, wsl, docker, onLine } = makeRunners();
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await lifecycle.down({
      distro: 'Ubuntu',
      project: 'archon-bunshee-task-x',
      slug: 'task-x',
      baseClone: '/home/u/archon/repos/bunshee',
      worktree: '/home/u/archon/worktrees/bunshee/task-x',
    });

    expect(calls.docker).toEqual([['compose', '-p', 'archon-bunshee-task-x', 'down', '-v']]);
    const script = calls.wsl.map(c => c.script).join('\n');
    expect(script).toContain('worktree remove --force /home/u/archon/worktrees/bunshee/task-x');
    expect(script).toContain('branch -D sandbox/task-x');
  });

  test('a compose failure does not stop the worktree removal', async () => {
    const { calls, wsl, onLine } = makeRunners();
    const docker: SandboxDockerRunner = async () => {
      throw new Error('daemon down');
    };
    const lifecycle = new SandboxLifecycle({ wsl, docker, onLine });

    await lifecycle.down({
      distro: 'Ubuntu',
      project: 'p',
      slug: 's',
      baseClone: '/c',
      worktree: '/w',
    });

    expect(calls.wsl.map(c => c.script).join('\n')).toContain('worktree remove');
  });
});
