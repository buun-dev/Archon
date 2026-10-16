import {
  classifyIsolationError,
  getIsolationProvider,
  worktreeRegistrationMetadata,
  type ContainerEnvironment,
  type IContainerIsolationProvider,
  type IIsolationStore,
  type IsolationEnvironmentRow,
  type TaskIsolationRequest,
  type WorktreeCreationEnvironment,
  type WorktreeSetupExecutor,
} from '@archon/isolation';
import { createLogger } from '@archon/paths';
import type { OwnedWorktree } from '@archon/workflows/schemas/workflow-run';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflows.registered-worktree');
  return cachedLog;
}

export interface RegisteredWorktreeInput {
  request: TaskIsolationRequest;
  setupExecutor?: WorktreeSetupExecutor;
  /** The record's `workflow_id`; defaults to the request identifier. */
  workflowId?: string;
  createdByPlatform: string;
  createdByUserId?: string;
  /** Caller-owned record metadata; the creation provenance keys always win. */
  metadata?: Record<string, unknown>;
}

export interface RegisteredWorktree {
  env: WorktreeCreationEnvironment;
  envId: string;
  /** Present when this call created the worktree, so the run may remove it. */
  ownedWorktree?: OwnedWorktree;
  /** The commit a newly cut branch started from. */
  cutFromCommit?: string;
}

/**
 * Create a task worktree and register its isolation record, so `isolation list`,
 * `cleanup` and `complete` see it. Every launch path that makes a worktree outside the
 * isolation resolver goes through here.
 *
 * A provider failure is rethrown with the classified, actionable message; the git or
 * filesystem error stays on `cause`. The caller configures isolation first.
 */
export async function createRegisteredWorktree(
  isolation: Pick<IIsolationStore, 'create'>,
  input: RegisteredWorktreeInput
): Promise<RegisteredWorktree> {
  let env: WorktreeCreationEnvironment;
  try {
    env = await getIsolationProvider().create(input.request, input.setupExecutor);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(classifyIsolationError(error), { cause: error });
  }
  const record = await isolation.create({
    codebase_id: input.request.codebaseId,
    workflow_type: 'task',
    workflow_id: input.workflowId ?? input.request.identifier,
    provider: 'worktree',
    working_path: env.workingPath,
    branch_name: env.branchName,
    created_by_platform: input.createdByPlatform,
    ...(input.createdByUserId ? { created_by_user_id: input.createdByUserId } : {}),
    metadata: { ...input.metadata, ...worktreeRegistrationMetadata(env.metadata) },
  });
  const created = env.metadata.provenance === 'created' ? env.metadata : undefined;
  return {
    env,
    envId: record.id,
    ...(created ? { ownedWorktree: { envId: record.id, creationId: created.creationId } } : {}),
    ...(created?.cutFromCommit !== undefined ? { cutFromCommit: created.cutFromCommit } : {}),
  };
}

export interface RegisteredContainerEnvInput {
  request: TaskIsolationRequest;
  /** The per-dispatch provider `selectIsolationProvider` built for this repo. */
  provider: IContainerIsolationProvider;
  /** The record's `workflow_id`; defaults to the request identifier. */
  workflowId?: string;
  createdByPlatform: string;
  createdByUserId?: string;
  /** Caller-owned record metadata; the sandbox keys always win. */
  metadata?: Record<string, unknown>;
}

/**
 * Create a repo-kind container sandbox and register its isolation record, the container
 * sibling of {@link createRegisteredWorktree}. The row's `provider: 'container'` is what
 * upstream's active-container predicate lists, what blocks codebase deletion, and what
 * routes abandon and cancel to the container reclaim.
 *
 * The row carries the compose project, which re-addresses the stack, and the base the
 * sandbox was cut from, so a resume reads a fixed base rather than a config value that
 * may have moved. It gets no worktree registration id: the store mints one for worktree
 * rows only.
 *
 * A provider failure is rethrown with the classified message; the original error stays
 * on `cause`. The provider refuses a request it cannot honor before provisioning. When
 * the row write fails after the sandbox came up, the sandbox is destroyed before the
 * row error is rethrown: a stack no row records is one nothing lists, guards or reclaims.
 */
export async function createRegisteredContainerEnv(
  isolation: Pick<IIsolationStore, 'create'>,
  input: RegisteredContainerEnvInput
): Promise<{ env: ContainerEnvironment; envId: string }> {
  let env: ContainerEnvironment;
  try {
    env = await input.provider.create(input.request);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw new Error(classifyIsolationError(error), { cause: error });
  }
  let record: IsolationEnvironmentRow;
  try {
    record = await isolation.create({
      codebase_id: input.request.codebaseId,
      workflow_type: 'task',
      workflow_id: input.workflowId ?? input.request.identifier,
      provider: 'container',
      working_path: env.workingPath,
      branch_name: env.branchName,
      created_by_platform: input.createdByPlatform,
      ...(input.createdByUserId ? { created_by_user_id: input.createdByUserId } : {}),
      metadata: { ...input.metadata, container_project: env.project, base_branch: env.baseBranch },
    });
  } catch (rowError) {
    // Best effort: the row error is the one the caller must see, so a teardown that
    // fails, or reports what it could not tear down, is logged and never thrown over it.
    const context = { workingPath: env.workingPath, project: env.project };
    try {
      const { warnings } = await input.provider.destroy(env.workingPath);
      if (warnings.length > 0) {
        getLog().warn(
          { ...context, warnings },
          'container_env.unrecorded_sandbox_destroy_incomplete'
        );
      }
    } catch (destroyError) {
      getLog().error(
        { ...context, err: destroyError },
        'container_env.unrecorded_sandbox_destroy_failed'
      );
    }
    throw rowError;
  }
  return { env, envId: record.id };
}
