/**
 * The form in which a run's paths reach its nodes.
 *
 * The engine holds every path in host form. On a Windows host whose nodes run
 * inside a WSL2 container, a node cannot open `C:\…`, so each delivery site — a
 * `$VAR` substitution, an exec node's environment — hands the node
 * `toNodePath(hostPath)` instead. Converting at delivery, rather than carrying a
 * second form of each path through the engine, leaves one path per concept and
 * one place that decides the node's form.
 *
 * `executeWorkflow` binds a run's visibility around its DAG, beside the adopted-dir
 * scope (`runWithAdoptedRunDir`). A `workflow:` child re-enters `executeWorkflow`
 * and binds its own, so it never inherits its parent's form.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { toNodeVisiblePath } from '@archon/paths';

/** Where a run's nodes open paths: on the host itself, or inside the WSL2 distro. */
export type NodeVisibility = 'host' | 'wsl';

export interface NodePathBinding {
  visibility: NodeVisibility;
  toNode: (hostPath: string) => string;
}

const nodePathContext = new AsyncLocalStorage<NodePathBinding>();

export function nodePathBindingFor(visibility: NodeVisibility): NodePathBinding {
  switch (visibility) {
    case 'host':
      return { visibility, toNode: hostPath => hostPath };
    case 'wsl':
      return { visibility, toNode: toNodeVisiblePath };
  }
}

export function runWithNodePaths<T>(binding: NodePathBinding, fn: () => Promise<T>): Promise<T> {
  return nodePathContext.run(binding, fn);
}

/**
 * The node's form of a host path under the current run's binding. Identity when
 * unbound: code outside `executeWorkflow` (the dry run) delivers to the host.
 * An empty value means "no path" (an absent adoption, a caller with no listing)
 * and stays empty rather than becoming a converted root.
 */
export function toNodePath(hostPath: string): string {
  const binding = nodePathContext.getStore();
  if (binding === undefined || hostPath === '') return hostPath;
  return binding.toNode(hostPath);
}

export function currentNodeVisibility(): NodeVisibility {
  return nodePathContext.getStore()?.visibility ?? 'host';
}
