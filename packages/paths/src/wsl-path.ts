/**
 * Windows host path to the form a WSL2 distro — and a container inside it — can
 * open.
 *
 * This is the ONLY path translation the engine performs, and it exists for one
 * structural reason: the engine is a Windows process while its sandboxed nodes are
 * Linux. It is applied once per run, in `composeRunPaths`, before any prompt
 * substitution, environment construction, or argv building. Nothing downstream
 * translates anything.
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
