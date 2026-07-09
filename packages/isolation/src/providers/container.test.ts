import { describe, test, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';

import * as git from '@archon/git';
import type { IsolationRequest } from '../types';
import { ContainerProvider } from './container';

/**
 * ContainerProvider mirrors WorktreeProvider but shells the P1 `sandbox.sh`
 * lifecycle (up/down) via wsl.exe and queries `docker compose` for state.
 * Every subprocess goes through `@archon/git` execFileAsync, so the tests spy
 * that single seam and assert on argv — no live docker/wsl needed.
 */
describe('ContainerProvider', () => {
  let provider: ContainerProvider;
  let execSpy: Mock<typeof git.execFileAsync>;
  let defaultBranchSpy: Mock<typeof git.getDefaultBranch>;

  const issueRequest: IsolationRequest = {
    workflowType: 'issue',
    identifier: '42',
    codebaseId: 'cb1',
    canonicalRepoPath: '/repo/marphob-page' as unknown as IsolationRequest['canonicalRepoPath'],
  };

  beforeEach(() => {
    provider = new ContainerProvider();
    execSpy = spyOn(git, 'execFileAsync');
    execSpy.mockResolvedValue({ stdout: '', stderr: '' });
    // create() auto-detects the base branch when repo config omits it, and
    // getDefaultBranch throws rather than falling back — stub it for every test.
    defaultBranchSpy = spyOn(git, 'getDefaultBranch');
    defaultBranchSpy.mockResolvedValue(
      'master' as Awaited<ReturnType<typeof git.getDefaultBranch>>
    );
  });

  afterEach(() => {
    execSpy.mockRestore();
    defaultBranchSpy.mockRestore();
  });

  test('providerType is container', () => {
    expect(provider.providerType).toBe('container');
  });

  test('create() provisions via sandbox.sh up and returns a container env', async () => {
    const env = await provider.create(issueRequest);

    expect(env.provider).toBe('container');
    expect(env.workingPath).toBe('/home/bunny/archon/worktrees/marphob-page/issue-42');
    expect(env.id).toBe(env.workingPath);
    expect(env.status).toBe('active');
    if (env.provider !== 'container') throw new Error('expected container env');
    expect(env.project).toBe('archon-issue-42');
    expect(env.containerWorkdir).toBe('/work');
    // sandbox.sh (real LF-safe path) driven through wsl.exe -d Ubuntu -- bash …
    expect(execSpy).toHaveBeenCalledWith(
      'wsl.exe',
      expect.arrayContaining([
        '-d',
        'Ubuntu',
        '--',
        'bash',
        expect.stringContaining('sandbox.sh'),
        'up',
        'issue-42',
      ]),
      expect.any(Object)
    );
  });

  test('destroy() shells sandbox.sh down with the slug from the working path', async () => {
    const result = await provider.destroy('/home/bunny/archon/worktrees/marphob-page/issue-42');

    expect(result.worktreeRemoved).toBe(true);
    expect(execSpy).toHaveBeenCalledWith(
      'wsl.exe',
      expect.arrayContaining([
        '-d',
        'Ubuntu',
        '--',
        'bash',
        expect.stringContaining('sandbox.sh'),
        'down',
        'issue-42',
      ]),
      expect.any(Object)
    );
  });

  test('destroy() is best-effort — a sandbox.sh failure still resolves', async () => {
    execSpy.mockRejectedValueOnce(new Error('down blew up'));
    const result = await provider.destroy('/home/bunny/archon/worktrees/marphob-page/issue-42');
    expect(result.worktreeRemoved).toBe(true);
  });

  test('healthCheck() queries docker compose ps for the agent service', async () => {
    execSpy.mockResolvedValueOnce({ stdout: '{"Service":"agent","State":"running"}', stderr: '' });
    const healthy = await provider.healthCheck(
      '/home/bunny/archon/worktrees/marphob-page/issue-42'
    );
    expect(healthy).toBe(true);
    expect(execSpy).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['compose', '-p', 'archon-issue-42', 'ps']),
      expect.any(Object)
    );
  });

  test('healthCheck() returns false when compose has no running agent', async () => {
    execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const healthy = await provider.healthCheck(
      '/home/bunny/archon/worktrees/marphob-page/issue-42'
    );
    expect(healthy).toBe(false);
  });

  test('get() returns null when the compose project is not running', async () => {
    execSpy.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const env = await provider.get('/home/bunny/archon/worktrees/marphob-page/issue-42');
    expect(env).toBeNull();
  });

  test('get() returns a container env when the agent is running', async () => {
    execSpy.mockResolvedValueOnce({ stdout: '{"Service":"agent","State":"running"}', stderr: '' });
    const env = await provider.get('/home/bunny/archon/worktrees/marphob-page/issue-42');
    expect(env?.provider).toBe('container');
    if (env?.provider !== 'container') throw new Error('expected container env');
    expect(env.project).toBe('archon-issue-42');
    expect(env.containerWorkdir).toBe('/work');
  });

  // P3-F: `sandbox.sh` cut the worktree from the base clone's HEAD because
  // create() shelled `up <slug>` and dropped the resolved base branch. The
  // worktree lives in the WSL distro, so the branch must cross the wsl.exe
  // boundary as an argument — the engine cannot `git -C` a distro path.
  test('create() passes the configured base branch to sandbox.sh up', async () => {
    const configured = new ContainerProvider(async () => ({ baseBranch: 'develop' }));

    await configured.create(issueRequest);

    const argv = execSpy.mock.calls[0]![1] as string[];
    expect(argv.slice(-3)).toEqual(['up', 'issue-42', 'develop']);
    // A configured branch means no needless git call against the host checkout.
    expect(defaultBranchSpy).not.toHaveBeenCalled();
  });

  test("create() falls back to the repo's default branch when config omits baseBranch", async () => {
    const configured = new ContainerProvider(async () => null);

    await configured.create(issueRequest);

    const argv = execSpy.mock.calls[0]![1] as string[];
    expect(argv.slice(-3)).toEqual(['up', 'issue-42', 'master']);
    // Resolved against the HOST checkout, which Windows git can reach.
    expect(defaultBranchSpy).toHaveBeenCalledWith('/repo/marphob-page');
  });

  // P3-D: create() dropped request.gitIdentity, so in-container commits fell
  // back to whatever identity was hand-stamped on the base clone. The engine
  // cannot `git -C` the distro worktree, so the identity crosses the wsl.exe
  // boundary as env — WSLENV is what makes wsl.exe translate it.
  const identityRequest: IsolationRequest = {
    ...issueRequest,
    gitIdentity: { email: '42+alice@users.noreply.github.com', name: 'Alice Example' },
  };

  test('create() forwards request.gitIdentity to sandbox.sh over WSLENV', async () => {
    await provider.create(identityRequest);

    const opts = execSpy.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env.ARCHON_GIT_USER_EMAIL).toBe('42+alice@users.noreply.github.com');
    expect(opts.env.ARCHON_GIT_USER_NAME).toBe('Alice Example');
    expect(opts.env.WSLENV).toContain('ARCHON_GIT_USER_EMAIL/u');
    expect(opts.env.WSLENV).toContain('ARCHON_GIT_USER_NAME/u');
  });

  test('create() forwards the email alone when the identity carries no name', async () => {
    await provider.create({ ...issueRequest, gitIdentity: { email: 'bob@example.com' } });

    const opts = execSpy.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env.ARCHON_GIT_USER_EMAIL).toBe('bob@example.com');
    expect(opts.env.ARCHON_GIT_USER_NAME).toBeUndefined();
    expect(opts.env.WSLENV).not.toContain('ARCHON_GIT_USER_NAME');
  });

  test('create() omits the identity vars when gitIdentity is absent (solo install)', async () => {
    // isPerUserGitHubEnabled() leaves gitIdentity undefined on a solo install;
    // sandbox.sh then keeps its own fallback identity.
    await provider.create(issueRequest);

    const opts = execSpy.mock.calls[0]![2] as { env: Record<string, string> };
    expect(opts.env.ARCHON_GIT_USER_EMAIL).toBeUndefined();
    expect(opts.env.WSLENV).not.toContain('ARCHON_GIT_USER_EMAIL');
  });

  test('list() maps archon- compose projects to container envs', async () => {
    execSpy.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { Name: 'archon-issue-42', Status: 'running(3)' },
        { Name: 'some-other-project', Status: 'running(1)' },
      ]),
      stderr: '',
    });
    const envs = await provider.list('cb1');
    expect(envs).toHaveLength(1);
    expect(envs[0]?.provider).toBe('container');
    if (envs[0]?.provider !== 'container') throw new Error('expected container env');
    expect(envs[0].project).toBe('archon-issue-42');
    expect(envs[0].workingPath).toBe('/home/bunny/archon/worktrees/marphob-page/issue-42');
  });
});
