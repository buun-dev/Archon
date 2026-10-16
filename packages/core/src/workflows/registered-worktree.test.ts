/**
 * Container registration — the sibling of `createRegisteredWorktree` that writes a
 * repo-kind sandbox's isolation row. The provider and the store are fakes passed as
 * arguments, so this file needs no module mocks.
 */
import { describe, expect, test } from 'bun:test';
import { toBranchName, toRepoPath } from '@archon/git';
import {
  classifyIsolationError,
  type ContainerEnvironment,
  type CreateEnvironmentParams,
  type IContainerIsolationProvider,
  type IIsolationStore,
  type IsolationEnvironmentRow,
  type TaskIsolationRequest,
} from '@archon/isolation';
import { createRegisteredContainerEnv } from './registered-worktree';

const request: TaskIsolationRequest = {
  workflowType: 'task',
  identifier: 'assist-1',
  codebaseId: 'cb-1',
  codebaseName: 'owner/repo',
  canonicalRepoPath: toRepoPath('/repos/repo'),
  description: 'CLI workflow: assist',
};

const env: ContainerEnvironment = {
  id: '/home/u/archon/worktrees/repo/task-assist-1',
  provider: 'container',
  workingPath: '/home/u/archon/worktrees/repo/task-assist-1',
  branchName: toBranchName('sandbox/task-assist-1'),
  baseBranch: toBranchName('dev'),
  project: 'archon-repo-task-assist-1',
  execContext: { kind: 'container', containerId: 'cid-1', execUser: '1000' },
  status: 'active',
  createdAt: new Date(),
  metadata: { request },
};

function notUsed(method: string): never {
  throw new Error(`${method} is not part of registration`);
}

/** A provider whose `create` is the one method registration may call. */
function fakeProvider(
  create: (request: TaskIsolationRequest) => Promise<ContainerEnvironment>
): IContainerIsolationProvider {
  return {
    providerType: 'container',
    create: req => {
      if (req.workflowType !== 'task') throw new Error('expected a task request');
      return create(req);
    },
    reattach: () => notUsed('reattach'),
    writeBackBackend: () => notUsed('writeBackBackend'),
    stop: () => notUsed('stop'),
    inspect: () => notUsed('inspect'),
    destroy: () => notUsed('destroy'),
  };
}

/** A store that records every row it is asked to create. */
function fakeStore(): Pick<IIsolationStore, 'create'> & { rows: CreateEnvironmentParams[] } {
  const rows: CreateEnvironmentParams[] = [];
  return {
    rows,
    create: (params): Promise<IsolationEnvironmentRow> => {
      rows.push(params);
      return Promise.resolve({
        id: 'iso-container-1',
        codebase_id: params.codebase_id,
        workflow_type: params.workflow_type,
        workflow_id: params.workflow_id,
        provider: params.provider ?? 'worktree',
        working_path: params.working_path,
        branch_name: params.branch_name,
        status: 'active',
        created_at: new Date(),
        created_by_platform: params.created_by_platform ?? null,
        created_by_user_id: params.created_by_user_id ?? null,
        metadata: params.metadata ?? {},
      });
    },
  };
}

describe('createRegisteredContainerEnv', () => {
  test("createRegisteredContainerEnv writes a provider 'container' row with the compose project", async () => {
    const created: TaskIsolationRequest[] = [];
    const store = fakeStore();

    const result = await createRegisteredContainerEnv(store, {
      request,
      provider: fakeProvider(req => {
        created.push(req);
        return Promise.resolve(env);
      }),
      createdByPlatform: 'cli',
      createdByUserId: 'user-1',
      metadata: { note: 'caller-owned' },
    });

    expect(created).toEqual([request]);
    expect(store.rows).toEqual([
      {
        codebase_id: 'cb-1',
        workflow_type: 'task',
        workflow_id: 'assist-1',
        provider: 'container',
        working_path: '/home/u/archon/worktrees/repo/task-assist-1',
        branch_name: toBranchName('sandbox/task-assist-1'),
        created_by_platform: 'cli',
        created_by_user_id: 'user-1',
        metadata: {
          note: 'caller-owned',
          container_project: 'archon-repo-task-assist-1',
          base_branch: 'dev',
        },
      },
    ]);
    // The store mints a worktree registration id for worktree rows only; this call
    // must not hand it one.
    expect(store.rows[0]?.metadata).not.toHaveProperty('worktree_registration_id');
    expect(result).toEqual({ env, envId: 'iso-container-1' });
  });

  test('rethrows a provider failure with the classified message and the cause', async () => {
    const failure = new Error(
      "Container isolation is unavailable: the WSL distro 'Ubuntu' is not reachable."
    );
    const store = fakeStore();

    const error = await createRegisteredContainerEnv(store, {
      request,
      provider: fakeProvider(() => Promise.reject(failure)),
      createdByPlatform: 'cli',
    }).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(classifyIsolationError(failure));
    expect((error as Error).cause).toBe(failure);
    expect(store.rows).toEqual([]);
  });
});
