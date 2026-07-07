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
  });

  afterEach(() => {
    execSpy.mockRestore();
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
