import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockDiscoverWorkflowsWithConfig = mock(() => Promise.resolve({ workflows: [], errors: [] }));

mock.module('@archon/workflows/workflow-discovery', () => ({
  discoverWorkflowsWithConfig: mockDiscoverWorkflowsWithConfig,
}));

const mockLoadRepoConfig = mock(() => Promise.resolve(null));
const mockLoadConfig = mock(() =>
  Promise.resolve({
    assistant: 'claude',
    aliases: {},
    tiers: {},
  })
);

mock.module('@archon/core', () => ({
  loadConfig: mockLoadConfig,
  loadRepoConfig: mockLoadRepoConfig,
}));

import { validateWorkflowsCommand } from './validate';

describe('validateWorkflowsCommand', () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const mockConsoleLog = mock(() => {});
  const mockConsoleError = mock(() => {});
  // `--json` output goes through writeStdout (process.stdout.write), NOT console.log:
  // console.log silently drops the remainder of a short write on a pipe, truncating
  // JSON with exit 0 (#2384). Capture the real channel or this asserts on nothing.
  let stdout: string[] = [];

  beforeEach(() => {
    mockDiscoverWorkflowsWithConfig.mockClear();
    mockLoadRepoConfig.mockClear();
    mockLoadConfig.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    stdout = [];
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      // writeStdout awaits this callback — never resolving would hang the test.
      const done = rest.find(arg => typeof arg === 'function') as
        | ((error?: Error | null) => void)
        | undefined;
      done?.(null);
      return true;
    }) as typeof process.stdout.write;
    console.log = mockConsoleLog;
    console.error = mockConsoleError;
    mockLoadRepoConfig.mockResolvedValue(null);
    mockLoadConfig.mockResolvedValue({
      assistant: 'claude',
      aliases: {},
      tiers: {},
    });
  });

  test('rejects bundled @custom model refs via discovered source', async () => {
    mockDiscoverWorkflowsWithConfig.mockResolvedValueOnce({
      workflows: [
        {
          source: 'bundled',
          workflow: {
            name: 'bad-bundled',
            model: '@custom',
            nodes: [{ id: 'step1', prompt: 'hello' }],
          },
        },
      ],
      errors: [],
    });

    const exitCode = await validateWorkflowsCommand('/tmp/repo', undefined, true);

    expect(exitCode).toBe(1);
    expect(stdout.join('')).toContain('@custom');
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
  });
});
