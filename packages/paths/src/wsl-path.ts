/**
 * Converts a Windows host path to the form a WSL2 distro, and a container inside
 * it, can open.
 *
 * The engine holds host paths throughout; this conversion is applied only where a
 * host path crosses into the distro, never earlier. Two production callers:
 *
 * - `packages/workflows/src/node-path.ts`: run paths delivered to a node. Its
 *   `toNodePath()` is identity on host runs and applies this conversion on `'wsl'`
 *   runs.
 * - `packages/isolation/src/providers/container.ts`: host-side mount sources handed
 *   to `compose up` inside the distro.
 *
 * Anything that is not a drive-letter path is returned unchanged, so callers never
 * branch: a POSIX path, an already-converted path, and a relative path all pass
 * through.
 */
export function toNodeVisiblePath(hostPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(hostPath);
  if (!match) return hostPath;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}
