import { describe, expect, test } from 'bun:test';
import { buildExecNodeEnvironment, type ExecNodeEnvironmentContext } from './exec-environment';
import { runWithNodePaths, type NodePathBinding } from './node-path';

const markerBinding: NodePathBinding = { visibility: 'wsl', toNode: p => '/node' + p };

function makeContext(
  overrides: Partial<ExecNodeEnvironmentContext> = {}
): ExecNodeEnvironmentContext {
  return {
    artifactsDir: '/host/artifacts',
    stateDir: '/host/state',
    logDir: '/host/logs',
    workflowId: 'run-1',
    baseBranch: 'main',
    userMessage: 'msg',
    loopUserInput: 'feedback',
    loopPrevOutput: 'previous',
    rejectionReason: 'reason',
    issueContext: 'issue',
    adoptedRunDir: '/host/adopted',
    typedArtifactsFile: '/host/typed.json',
    nodeExecution: null,
    ...overrides,
  };
}

describe('buildExecNodeEnvironment', () => {
  test("delivers every run path in the node's form", async () => {
    const env = await runWithNodePaths(markerBinding, async () =>
      buildExecNodeEnvironment(makeContext())
    );

    expect(env).toMatchObject({
      ARTIFACTS_DIR: '/node/host/artifacts',
      STATE_DIR: '/node/host/state',
      LOG_DIR: '/node/host/logs',
      ADOPTED_RUN_DIR: '/node/host/adopted',
      TYPED_ARTIFACTS_FILE: '/node/host/typed.json',
    });
  });

  test('leaves an absent adopted run directory empty', async () => {
    const env = await runWithNodePaths(markerBinding, async () =>
      buildExecNodeEnvironment(makeContext({ adoptedRunDir: undefined }))
    );

    expect(env.ADOPTED_RUN_DIR).toBe('');
  });

  test('leaves every non-path key unchanged', async () => {
    const context = makeContext();
    const unbound = buildExecNodeEnvironment(context);
    const bound = await runWithNodePaths(markerBinding, async () =>
      buildExecNodeEnvironment(context)
    );
    const pathKeys = new Set([
      'ARTIFACTS_DIR',
      'STATE_DIR',
      'LOG_DIR',
      'ADOPTED_RUN_DIR',
      'TYPED_ARTIFACTS_FILE',
    ]);
    const withoutPaths = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
      Object.fromEntries(Object.entries(env).filter(([key]) => !pathKeys.has(key)));

    expect(withoutPaths(bound)).toEqual(withoutPaths(unbound));
    expect(unbound).toMatchObject({
      ARTIFACTS_DIR: '/host/artifacts',
      STATE_DIR: '/host/state',
      LOG_DIR: '/host/logs',
      ADOPTED_RUN_DIR: '/host/adopted',
      TYPED_ARTIFACTS_FILE: '/host/typed.json',
      WORKFLOW_ID: 'run-1',
    });
  });
});
