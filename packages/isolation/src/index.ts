// --- Types ---
export type {
  IsolationProviderType,
  IsolationWorkflowType,
  EnvironmentStatus,
  IssueIsolationRequest,
  PRIsolationRequest,
  ReviewIsolationRequest,
  ThreadIsolationRequest,
  TaskBranchSelection,
  TaskIsolationRequest,
  IsolationRequest,
  AdoptedWorktreeMetadata,
  CreatedWorktreeMetadata,
  ObservedWorktreeMetadata,
  WorktreeCreationEnvironment,
  WorktreeMetadata,
  WorktreeEnvironment,
  IsolatedEnvironment,
  ContainerEnvironment,
  ContainerEnvironmentMetadata,
  IContainerIsolationProvider,
  SandboxInspection,
  DestroyOptions,
  WorktreeDestroyOptions,
  DestroyResult,
  IIsolationProvider,
  IsolationHints,
  IsolationBlockReason,
  IsolationEnvironmentRow,
  WorktreeCreateConfig,
  RepoConfigLoader,
  WorktreeStatusBreakdown,
  CreateEnvironmentParams,
  ResolveRequest,
  ResolutionMethod,
  IsolationResolution,
  ResolvedIsolation,
  ExecutionContext,
  WriteBackFinalizeResult,
  WriteBackApplySummary,
  BackendPrepareRequest,
  PreparedEnv,
  IIsolationBackend,
  ContainerBackendConfig,
} from './types';

export {
  isPRIsolationRequest,
  CONTAINER_LABELS,
  worktreeRegistrationMetadata,
  WORKTREE_REGISTRATION_ID,
  readWorktreeCreationId,
  readWorktreeBranchCreated,
} from './types';

// --- Backend seam (folder projects) ---
export { resolveFolderBackend } from './backend-router';
export type { ResolveFolderBackendOptions } from './backend-router';
export { InPlaceBackend } from './backends/in-place';
export { ContainerBackend } from './backends/container';
export type { ContainerBackendDeps } from './backends/container';

// --- Container backend primitives (docker CLI wrapper) ---
export { dockerCli, dockerPreflight, extractDockerError } from './container/docker-exec';
export type { DockerRunner, DockerExecOptions, DockerExecResult } from './container/docker-exec';

// --- Repo-kind sandbox lifecycle (WSL2 docker compose) ---
export {
  SANDBOX_HOST_DEFAULTS,
  resolveSandboxHost,
  SandboxLifecycle,
  defaultWslRunner,
  defaultSandboxDocker,
  shq,
} from './backends/sandbox';
export type {
  SandboxHostConfig,
  RepoSandboxConfig,
  ResolvedSandboxHost,
  WslRunner,
  SandboxDockerRunner,
} from './backends/sandbox';

// --- Store ---
export type { IIsolationStore } from './store';
export { recordWorktreeAdoption } from './store';

// --- Errors ---
export {
  ExistingBranchDivergedError,
  IsolationBlockedError,
  MissingProjectDirectoryError,
  WorktreeLeftoverError,
  WorktreeUncommittedChangesError,
  classifyIsolationError,
} from './errors';

// --- Factory ---
export {
  getIsolationProvider,
  configureIsolation,
  resetIsolationProvider,
  selectIsolationProvider,
  assertIsolationProviderRecognized,
  isContainerIsolationProvider,
  type ConfigurableProvider,
} from './factory';

// --- Resolver ---
export { IsolationResolver } from './resolver';
export type { IsolationResolverDeps } from './resolver';

// --- Provider ---
export { WorktreeProvider, resolveRepoLocalOverride } from './providers/worktree';
export {
  ContainerProvider,
  assertContainerPrerequisites,
  assertContainerRequestSupported,
  assertRepoSandboxConfigComplete,
  composeProjectFor,
  composeProjectFromWorkingPath,
  SANDBOX_COMPOSE_FILE,
} from './providers/container';
export type {
  ContainerProviderDeps,
  ContainerPrerequisiteDeps,
  ContainerPrerequisites,
  RepoSandboxConfigLoader,
  SandboxHostConfigLoader,
} from './providers/container';

// --- PR state lookup ---
export { getPrState } from './pr-state';
export type { PrLookup } from './pr-state';

// --- Worktree copy utility ---
export {
  copyWorktreeFiles,
  copyWorktreeFile,
  parseCopyFileEntry,
  isPathWithinRoot,
} from './worktree-copy';
export type { CopyFileEntry } from './worktree-copy';

export { validateWorktreePostCreate } from './post-create-config';
export type { WorktreeSetupExecutor, WorktreeSetupInput } from './types';
export { WorktreePostCreateError } from './errors';
