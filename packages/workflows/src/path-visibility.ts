/**
 * The run path visibility contract: which filesystem each engine-owned path of a
 * run resolves on, and a pre-execution check that a container run carries both
 * forms of everything that needs both.
 *
 * ## Why a contract rather than a fallback
 *
 * The engine is a Windows process whose nodes may execute inside a WSL2 container,
 * so such a run has two forms of every path: `C:\Users\...` for the engine and
 * `/mnt/c/Users/...` for the node. The pairing used to be carried only by
 * `hostArtifactsDir ?? artifactsDir` and `nodeLogDir ?? logDir`, spelled out at
 * each of nine readers. Nothing declared which form a field was supposed to hold,
 * and nothing checked — so a reader that reached for the wrong one did not fail.
 * On a container run the engine opened a `/mnt/c/...` string, Windows resolved it
 * drive-relative, and the write landed in a literal `<cwd-drive>:\mnt\c\...` tree
 * that no cleanup, no scanner and no reader ever visits. That is not hypothetical:
 * it is what the per-user provider credential file did for eight weeks, and twenty
 * real files were recovered from that tree.
 *
 * {@link RUN_PATH_CONTRACT} is the declaration — one entry per engine-owned path
 * the run uses (upstream #2206's list: workspace, artifacts, logs, state, docs,
 * provider working directory). {@link assertRunPathsResolve} is the check, and it
 * reads that declaration rather than restating it, so the two cannot drift.
 *
 * ## Why the check is a throw, and why it runs where it does
 *
 * A bad read is silent, so a failure discovered at the first bad read is not a
 * failure at all — it is a stray directory found weeks later. The check therefore
 * runs once in `executeWorkflow`, before the artifacts mkdir and before the DAG
 * boundary, over the very locals that are forwarded to the DAG.
 */

/**
 * Where this run's nodes execute, as far as path resolution is concerned.
 *
 * `'host'` — nodes see the same filesystem the engine does. Host-visible IS
 * node-visible and nothing is converted.
 * `'wsl'` — nodes execute inside the WSL2 distro (a repo-kind container run), where
 * the engine's `C:\...` paths do not resolve.
 */
export type NodeVisibility = 'host' | 'wsl';

/**
 * The engine-owned paths of a run, in the forms `executeWorkflow` holds them.
 *
 * `hostArtifactsDir`/`hostStateDir` are the `?? `-collapsed locals, so they are
 * always a string: on a host run they are the same string as their partner, and on
 * a `'wsl'` run where the conversion never happened they are the NODE form — which
 * is exactly what the check catches. `nodeLogDir` has no such collapse (its readers
 * spell the fallback themselves), so there its absence is the detectable failure.
 */
export interface RunPaths {
  /** `$WORKSPACE` — the checkout nodes act on. */
  cwd: string;
  artifactsDir: string;
  hostArtifactsDir: string;
  stateDir: string;
  hostStateDir: string;
  logDir: string;
  nodeLogDir?: string | undefined;
  outputRoot: string;
  docsDir: string;
}

/**
 * Which filesystem a declared path resolves on.
 *
 * `'node'` — resolves for the node. On a `'wsl'` run the engine must not open it.
 * `'host'` — resolves for the engine. On a `'wsl'` run a node must not open it.
 * `'relative'` — not on the axis at all; resolves on whichever side reads it.
 */
export type PathAxis = 'host' | 'node' | 'relative';

/** One declared path: the form the field carries, and its opposite-form partner. */
interface PathDeclaration {
  carries: PathAxis;
  /**
   * The field holding the same bytes in the OPPOSITE form. Required on a `'wsl'`
   * run; absent means this path has no second form, either because none exists or
   * because no consumer on the other side has ever needed one.
   */
  sibling?: keyof RunPaths;
}

/**
 * Keyed on {@link RunPaths} rather than on `string`, so the compiler — not a
 * comment — is what keeps the declaration and the shape it declares in agreement.
 * `Partial` because the sibling fields are declared BY their partner's entry and
 * must not appear as entries of their own.
 */
type RunPathContract = Readonly<Partial<Record<keyof RunPaths, PathDeclaration>>>;

/**
 * Every engine-owned path of a run, declared host-visible, node-visible, or
 * relative — with its opposite-form sibling where one is required.
 *
 * The direction of each entry is a COUNTING rule, not a preference: a field points
 * at whichever side has more consumers, so the larger population is correct without
 * being touched, and the smaller one gets an explicit sibling. `artifactsDir` and
 * `stateDir` are node-visible because 28 sites substitute them into node text and 8
 * open them as files; `logDir` points the other way because ~32 engine writes read
 * it against 2 node deliveries. See the field docs on `ResolvedProjectPaths` in
 * `executor.ts` for the per-field arithmetic.
 *
 * Adding a run-scoped path? Add it here, and the check below covers it for free.
 */
export const RUN_PATH_CONTRACT: RunPathContract = {
  /**
   * Node-visible with NO host sibling, and that is not an omission: a repo-kind
   * container run's checkout lives inside the distro at `/home/<user>/...`, a path
   * with no host form at all. Any engine-side filesystem access through `cwd` on
   * such a run is broken by construction, not by a missing pairing.
   */
  cwd: { carries: 'node' },
  artifactsDir: { carries: 'node', sibling: 'hostArtifactsDir' },
  /**
   * Node-visible with a host sibling for the engine's own pre-create mkdir. The
   * sibling is deliberately NOT forwarded to the DAG: nothing inside the DAG opens
   * `stateDir`, it only substitutes it into node text and compares it as a string,
   * so a host form there would have no consumer.
   */
  stateDir: { carries: 'node', sibling: 'hostStateDir' },
  /**
   * Host-visible — the opposite direction from the two above, and load-bearing.
   * The engine writes the transcript host-side and reads it back through
   * `getRunLogPathForRoot(outputRoot, ...)`; converting this field split writer from
   * reader and returned nothing from `archon run get` on every container run.
   */
  logDir: { carries: 'host', sibling: 'nodeLogDir' },
  /**
   * Host-visible engine bookkeeping that never reaches a node: `resolveProjectPaths`
   * and `resolveRunStorageRoot` both gate a persisted root on `isInsideArchonHome`,
   * which a `/mnt/<drive>` value fails — so a node-visible `output_root` would make
   * a run's own transcript and artifacts unreadable.
   */
  outputRoot: { carries: 'host' },
  /** `config.docsPath ?? 'docs/'` — relative to the workspace, so off the axis. */
  docsDir: { carries: 'relative' },
};

/** A declared path that does not resolve on the side its declaration names. */
export class RunPathContractError extends Error {
  constructor(
    /** The `RunPaths` field at fault — the one a fix has to change. */
    readonly field: string,
    message: string
  ) {
    super(message);
    this.name = 'RunPathContractError';
  }
}

/** `/mnt/<drive>/...` — the form a WSL2 node opens, and Windows resolves drive-relative. */
function isNodeForm(path: string): boolean {
  return /^\/mnt\/[A-Za-z]\//.test(path);
}

/** `C:\...` or `C:/...` — the form the Windows engine opens, and a Linux node cannot. */
function isHostForm(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * A path is checked for what it must NOT be, not for what it must be: on a storage
 * root with no drive letter — a folder-kind container run, or any POSIX fixture —
 * the two forms are one string, and demanding a drive letter would fail a run that
 * is entirely correct. Both predicates pass such a path, which is the right answer.
 */
function checkAxis(field: string, path: string, axis: PathAxis): void {
  if (axis === 'node' && isHostForm(path)) {
    throw new RunPathContractError(
      field,
      `${field} must be node-visible on a container run, but it is the host form ` +
        `(${path}). A node cannot open a drive-lettered path.`
    );
  }
  if (axis === 'host' && isNodeForm(path)) {
    throw new RunPathContractError(
      field,
      `${field} must be host-visible on a container run, but it is the node form ` +
        `(${path}). The engine is a Windows process and would resolve it ` +
        'drive-relative, writing to a stray tree nothing reads.'
    );
  }
}

/** The other side of the axis — derived, so a declaration cannot name it wrongly. */
function oppositeAxis(axis: PathAxis): PathAxis {
  return axis === 'host' ? 'node' : 'host';
}

/**
 * Verify that every path in {@link RUN_PATH_CONTRACT} resolves on the side it is
 * declared for, and that each required opposite-form sibling is present and
 * resolves on the other side. Throws {@link RunPathContractError} naming the field
 * at fault.
 *
 * A `'host'` run returns immediately: node-visible IS host-visible there, every
 * field is both, and there is nothing to pair — the invariant that keeps host runs
 * byte-for-byte unaffected.
 */
export function assertRunPathsResolve(paths: RunPaths, nodeVisibility: NodeVisibility): void {
  if (nodeVisibility === 'host') return;
  for (const field of Object.keys(RUN_PATH_CONTRACT) as (keyof RunPaths)[]) {
    const declaration = RUN_PATH_CONTRACT[field];
    if (!declaration || declaration.carries === 'relative') continue;
    checkAxis(field, paths[field] ?? '', declaration.carries);
    if (!declaration.sibling) continue;
    const sibling = paths[declaration.sibling];
    if (!sibling) {
      throw new RunPathContractError(
        declaration.sibling,
        `${declaration.sibling} is missing: a container run must carry the ` +
          `${oppositeAxis(declaration.carries)}-visible form of ${field} as well as ` +
          `the ${declaration.carries}-visible one.`
      );
    }
    checkAxis(declaration.sibling, sibling, oppositeAxis(declaration.carries));
  }
}
