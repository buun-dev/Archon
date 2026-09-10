/**
 * Tests for the run path visibility contract.
 *
 * A container run has two forms of every engine-owned path, and until this
 * contract existed nothing declared which form a given field was supposed to
 * carry. A reader that reached for the wrong one did not fail: the engine (a
 * Windows process) opened a `/mnt/c/...` string, Windows resolved it
 * drive-relative, and the write landed in a `<drive>:\mnt\c\...` tree no
 * cleanup, scanner or reader ever visits — the defect the provider credential
 * file hit for real.
 *
 * The values below are literal drive-lettered / `/mnt`-prefixed fixtures, never
 * platform-derived, so a wrong form is detectable on Linux CI too.
 */
import { describe, it, expect } from 'bun:test';
import {
  assertRunPathsResolve,
  RUN_PATH_CONTRACT,
  RunPathContractError,
  type RunPaths,
} from './path-visibility';

const HOST_ROOT = 'C:\\Users\\Test\\ArchonHome\\_cwd\\nodevis';
const NODE_ROOT = '/mnt/c/Users/Test/ArchonHome/_cwd/nodevis';

/** A total `'wsl'` pairing — what `composeRunPaths` produces on a container run. */
function wslPaths(overrides: Partial<RunPaths> = {}): RunPaths {
  return {
    cwd: '/home/bunny/archon/worktrees/widget/task-x',
    artifactsDir: `${NODE_ROOT}/artifacts/runs/run-1`,
    hostArtifactsDir: `${HOST_ROOT}\\artifacts\\runs\\run-1`,
    stateDir: `${NODE_ROOT}/state`,
    hostStateDir: `${HOST_ROOT}\\state`,
    logDir: `${HOST_ROOT}\\logs`,
    nodeLogDir: `${NODE_ROOT}/logs`,
    outputRoot: HOST_ROOT,
    docsDir: 'docs/',
    ...overrides,
  };
}

describe('assertRunPathsResolve', () => {
  it('accepts a total wsl pairing', () => {
    expect(() => assertRunPathsResolve(wslPaths(), 'wsl')).not.toThrow();
  });

  it('rejects a node-visible field left in the host form', () => {
    // `composeRunPaths` forgot to convert, or a caller passed the host form by
    // hand. Every one of the 28 sites that substitutes `$ARTIFACTS_DIR` into node
    // text would then hand the node a path it cannot open.
    const err = catchContractError(() =>
      assertRunPathsResolve(
        wslPaths({ artifactsDir: `${HOST_ROOT}\\artifacts\\runs\\run-1` }),
        'wsl'
      )
    );
    expect(err.field).toBe('artifactsDir');
    expect(err.message).toContain('artifactsDir');
    expect(err.message).toContain('node-visible');
  });

  it('rejects a host-visible field converted to the node form', () => {
    // The `logDir` conversion that broke `archon run get` for every container
    // run: the engine's ~32 transcript writes and its read-back through
    // getRunLogPathForRoot both need the host form.
    const err = catchContractError(() =>
      assertRunPathsResolve(wslPaths({ logDir: `${NODE_ROOT}/logs` }), 'wsl')
    );
    expect(err.field).toBe('logDir');
    expect(err.message).toContain('host-visible');
  });

  it('rejects a missing node-visible sibling', () => {
    // The `$LOG_DIR` delivery sites would silently fall back to the host form
    // and hand a container node a `C:\...` path.
    const err = catchContractError(() =>
      assertRunPathsResolve(wslPaths({ nodeLogDir: undefined }), 'wsl')
    );
    expect(err.field).toBe('nodeLogDir');
    expect(err.message).toContain('missing');
  });

  it('rejects a host-visible sibling that is really the node form', () => {
    // The credential-file defect in the shape the contract now catches: the
    // engine's own write is handed the node form of the artifacts dir.
    const err = catchContractError(() =>
      assertRunPathsResolve(
        wslPaths({ hostArtifactsDir: `${NODE_ROOT}/artifacts/runs/run-1` }),
        'wsl'
      )
    );
    expect(err.field).toBe('hostArtifactsDir');
    expect(err.message).toContain('host-visible');
  });

  it('rejects a missing host-visible sibling for state', () => {
    const err = catchContractError(() =>
      assertRunPathsResolve(wslPaths({ hostStateDir: '' }), 'wsl')
    );
    expect(err.field).toBe('hostStateDir');
    expect(err.message).toContain('missing');
  });

  it('leaves a host run alone, drive letters and all', () => {
    // On a host run node-visible IS host-visible, both forms are the same string,
    // and there is nothing to pair — so nothing is checked. This is the invariant
    // that keeps host runs byte-for-byte unaffected.
    const hostRun: RunPaths = {
      cwd: 'C:\\repos\\widget',
      artifactsDir: `${HOST_ROOT}\\artifacts\\runs\\run-1`,
      hostArtifactsDir: `${HOST_ROOT}\\artifacts\\runs\\run-1`,
      stateDir: `${HOST_ROOT}\\state`,
      hostStateDir: `${HOST_ROOT}\\state`,
      logDir: `${HOST_ROOT}\\logs`,
      nodeLogDir: undefined,
      outputRoot: HOST_ROOT,
      docsDir: 'docs/',
    };
    expect(() => assertRunPathsResolve(hostRun, 'host')).not.toThrow();
  });

  it('accepts a wsl run on a storage root with no drive letter', () => {
    // A folder-kind container run, and every test rooted at a POSIX fixture, take
    // the same 'wsl' arm: `toNodeVisiblePath` passes a non-drive path through, so
    // both forms are one string and both directions hold.
    const flat = wslPaths({
      artifactsDir: '/tmp/ws/artifacts/runs/run-1',
      hostArtifactsDir: '/tmp/ws/artifacts/runs/run-1',
      stateDir: '/tmp/ws/state',
      hostStateDir: '/tmp/ws/state',
      logDir: '/tmp/ws/logs',
      nodeLogDir: '/tmp/ws/logs',
      outputRoot: '/tmp/ws',
    });
    expect(() => assertRunPathsResolve(flat, 'wsl')).not.toThrow();
  });

  it('declares docsDir off the host/node axis, so a relative value passes', () => {
    // `config.docsPath ?? 'docs/'` is relative to the workspace and resolves on
    // whichever side reads it. Declaring it is the point; converting it would be
    // wrong.
    expect(RUN_PATH_CONTRACT.docsDir?.carries).toBe('relative');
    expect(() => assertRunPathsResolve(wslPaths({ docsDir: 'docs/' }), 'wsl')).not.toThrow();
  });
});

function catchContractError(fn: () => void): RunPathContractError {
  try {
    fn();
  } catch (err) {
    if (err instanceof RunPathContractError) return err;
    throw err;
  }
  throw new Error('expected a RunPathContractError, but nothing was thrown');
}
