/**
 * Repo-kind sandbox lifecycle — the box Archon makes for a container run.
 *
 * A repo-kind container run executes inside a Docker stack in a WSL2 distro: a
 * git worktree cut from the repo's base clone in the distro, mounted at its own
 * path into an `agent` container, beside whatever services the repo's own compose
 * overlay declares. This file brings that stack up and tears it down; the
 * `ContainerProvider` decides WHAT to bring up (paths, config, identity) and
 * hands it here as a spec.
 *
 * Two runners, chosen by where a command has to run:
 *
 * - `wsl` runs a bash script INSIDE the distro (`wsl.exe -d <distro> --exec bash
 *   -c`). Everything that touches the distro filesystem goes here: the fetch, the
 *   worktree add, the handshake file, and `docker compose up` — the last one
 *   because every bind mount in the compose files is a distro path, and the same
 *   path handed to the Windows docker CLI is resolved by the daemon inside its own
 *   VM, where it names an empty directory (proved 2026-09-12: `docker run -v
 *   /home/…/repos/x:/x alpine ls /x` lists the repo from the distro and nothing
 *   from Windows, exit 0 both times). `--exec`, not `--`: `--` hands the joined
 *   command line to the distro's login shell, which expands `$VAR` and re-parses
 *   quotes before bash ever sees the script.
 * - `docker` is the Windows docker CLI, for the mount-free commands (`exec`,
 *   `down`), where the provider's other queries already live.
 *
 * Archon's half of the compose recipe ships in `packages/isolation/docker/`; the
 * repo's overlay lives in the worktree. Both are passed to compose as distro paths,
 * base first, so `./allowlist.txt` and `./init-firewall.sh` resolve against the
 * base file's directory.
 *
 * Provisioning is the repo's ONE command (design D1), run with open egress; the
 * firewall clamps down afterwards, before any agent work (D6). That order is the
 * security boundary and it is Archon's, so it stays here.
 */

import { spawn } from 'child_process';
import { createLogger } from '@archon/paths';

const log = createLogger('isolation.sandbox');

/**
 * Where the repo-kind sandbox lives on this machine — the global config's
 * `isolation.container` section. Every field has a default (below), so an empty
 * config keeps a machine on the original layout working. `@archon/core` re-exports
 * this as the config type; it is defined here because this is where it is read.
 */
export interface SandboxHostConfig {
  /** WSL distro the sandbox runs in. @default 'Ubuntu' */
  distro?: string;
  /** Runner image the compose `agent` service starts from. @default 'archon-runner:latest' */
  image?: string;
  /** Distro path holding one base clone per repo; `~` is the distro home. @default '~/archon/repos' */
  repoRoot?: string;
  /** Distro path each run's worktree is cut under; `~` is the distro home. @default '~/archon/worktrees' */
  worktreeRoot?: string;
  /** Stamped on the worktree when the dispatch carries no identity of its own. */
  gitIdentity?: { email: string; name?: string };
}

/**
 * The repo's side of the split — its `.archon/config.yaml` `isolation` section,
 * minus `provider`. `provision` is the one command Archon runs inside the fresh
 * container (required for a container run); `compose` is the repo's compose
 * overlay, relative to the repo root (optional).
 */
export interface RepoSandboxConfig {
  compose?: string;
  provision?: string;
}

/** The layout the lifecycle grew up on. `~` is the distro user's home. */
export const SANDBOX_HOST_DEFAULTS = {
  distro: 'Ubuntu',
  image: 'archon-runner:latest',
  repoRoot: '~/archon/repos',
  worktreeRoot: '~/archon/worktrees',
} as const;

export interface ResolvedSandboxHost {
  distro: string;
  image: string;
  /** Absolute distro path; `<repoRoot>/<repo>` is the base clone. */
  repoRoot: string;
  /** Absolute distro path; `<worktreeRoot>/<repo>/<slug>` is a run's worktree. */
  worktreeRoot: string;
  gitIdentity: { email: string; name?: string } | undefined;
}

/**
 * Apply the defaults and resolve `~` against the distro's home. The home comes
 * from the distro itself (the prerequisite probe echoes `$HOME`), never from a
 * guess: the worktree path doubles as the environment id, so it has to be the
 * concrete path the distro will use.
 */
export function resolveSandboxHost(
  config: SandboxHostConfig | undefined,
  distroHome: string
): ResolvedSandboxHost {
  const expand = (p: string): string =>
    p === '~' || p.startsWith('~/') ? distroHome + p.slice(1) : p;
  return {
    distro: config?.distro ?? SANDBOX_HOST_DEFAULTS.distro,
    image: config?.image ?? SANDBOX_HOST_DEFAULTS.image,
    repoRoot: expand(config?.repoRoot ?? SANDBOX_HOST_DEFAULTS.repoRoot),
    worktreeRoot: expand(config?.worktreeRoot ?? SANDBOX_HOST_DEFAULTS.worktreeRoot),
    gitIdentity: config?.gitIdentity,
  };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs: number;
  /** Extra environment for the command (forwarded over WSLENV for `wsl`). */
  env?: Record<string, string>;
  /** Receives each output line as it arrives — the provisioning transcript. */
  onLine?: (line: string) => void;
}

/** Runs one bash script inside the named distro. */
export type WslRunner = (distro: string, script: string, opts: RunOptions) => Promise<ExecResult>;
/** Runs the Windows `docker` CLI. */
export type SandboxDockerRunner = (args: string[], opts: RunOptions) => Promise<ExecResult>;

export interface SandboxLifecycleDeps {
  wsl: WslRunner;
  docker: SandboxDockerRunner;
  /** Sink for the lifecycle's transcript lines (the provider prefixes them). */
  onLine: (line: string) => void;
}

export interface SandboxUpSpec {
  distro: string;
  /** Compose project `archon-<repo>-<slug>`. */
  project: string;
  repo: string;
  slug: string;
  baseBranch: string;
  /** Distro path of the repo's base clone. */
  baseClone: string;
  /** Distro path of the run's worktree — also the container's working_dir. */
  worktree: string;
  image: string;
  /** Archon's base compose file, as the distro sees it. */
  composeBase: string;
  /** The repo's overlay inside the worktree, as the distro sees it. Absent = base only. */
  composeOverlay?: string;
  /** The repo's one provisioning command, run in the agent container after `up`. */
  provision: string;
  /** `~/.archon/scripts`, as the distro sees it. */
  scriptsDir: string;
  /** The run's project dir (artifacts + logs), as the distro sees it. */
  metaDir: string;
  /** Stamped on the worktree with `--worktree` scope; absent = inherit the clone's. */
  gitIdentity?: { email: string; name?: string };
  /** Forwarded into the distro for the fetch, and baked into the agent by compose. */
  secrets: { GH_TOKEN?: string; ANTHROPIC_API_KEY?: string };
}

export interface SandboxDownSpec {
  distro: string;
  project: string;
  slug: string;
  baseClone: string;
  worktree: string;
}

/** What the reap needs to know about a worktree, answered from inside the distro. */
export interface WorktreeInspection {
  exists: boolean;
  /** Uncommitted changes (`git status --porcelain` non-empty). */
  dirty: boolean;
  /** Commits reachable from HEAD but from no remote ref. */
  unpushed: boolean;
}

/** Marker the existence probe echoes; read out of stdout, never inferred from prose. */
const WORKTREE_EXISTS_MARKER = 'ARCHON_WORKTREE_EXISTS';
/** Markers the inspection probe echoes: either the first alone, or the other two. */
const WT_MISSING_MARKER = 'ARCHON_WT_MISSING';
const WT_DIRTY_MARKER = 'ARCHON_WT_DIRTY=';
const WT_UNPUSHED_MARKER = 'ARCHON_WT_UNPUSHED=';

const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
/** Compose may have to pull the overlay's images on a fresh machine. */
const COMPOSE_UP_TIMEOUT_MS = 10 * 60 * 1000;
/** `uv sync` + install + migrate + Playwright, cold caches included; be generous. */
const PROVISION_TIMEOUT_MS = 20 * 60 * 1000;
const FIREWALL_TIMEOUT_MS = 2 * 60 * 1000;
const COMPOSE_DOWN_TIMEOUT_MS = 5 * 60 * 1000;

/** Single-quote a value for bash unless it is plainly safe bare. */
export function shq(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** The most informative line off a failed child: the last thing it said on stderr. */
function lastLine(err: unknown): string {
  const e = err as Error & { stderr?: string; stdout?: string; code?: string | number };
  const pick = (s: string | undefined): string | undefined =>
    s
      ?.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .pop();
  return pick(e.stderr) ?? pick(e.stdout) ?? (e.code ? String(e.code) : e.message);
}

export class SandboxLifecycle {
  constructor(private readonly deps: SandboxLifecycleDeps) {}

  /**
   * Bring the stack up and provision it. Idempotent on the worktree: a re-`up` of
   * an existing worktree (reuse-by-branch) skips the fetch and the `worktree add`,
   * so it needs no token, and re-asserts everything else.
   */
  async up(spec: SandboxUpSpec): Promise<void> {
    const { onLine } = this.deps;
    const say = (line: string): void => {
      onLine(line);
    };

    if (!(await this.worktreeExists(spec))) {
      const token = spec.secrets.GH_TOKEN;
      if (!token) {
        throw new Error(
          `Sandbox up refused: GH_TOKEN is unset, so origin/${spec.baseBranch} cannot be fetched ` +
            `into ${spec.baseClone}. Set GH_TOKEN in the environment Archon runs in.`
        );
      }
      say(`fetching origin/${spec.baseBranch} into ${spec.baseClone}`);
      await this.fetchBase(spec, token);
      say(`cutting worktree ${spec.worktree} on sandbox/${spec.slug}`);
      await this.worktreeAdd(spec);
    } else {
      say(`reusing worktree ${spec.worktree}`);
    }

    if (spec.gitIdentity) await this.stampIdentity(spec, spec.gitIdentity);
    await this.writeHandshake(spec);

    say(`compose up ${spec.project}`);
    await this.composeUp(spec);

    say(`provisioning: ${spec.provision}`);
    await this.provision(spec);

    say('firewall: default-deny egress');
    await this.firewall(spec);
    log.info({ project: spec.project, worktree: spec.worktree }, 'sandbox.up');
  }

  /**
   * Best-effort teardown, every step independent of the one before: the stack
   * with its volumes (the shared caches are `external` and survive), then the
   * worktree and its branch in the distro.
   */
  async down(spec: SandboxDownSpec): Promise<void> {
    await this.deps
      .docker(['compose', '-p', spec.project, 'down', '-v'], { timeoutMs: COMPOSE_DOWN_TIMEOUT_MS })
      .catch(err => {
        log.warn({ project: spec.project, err: lastLine(err) }, 'sandbox.down.compose_failed');
      });
    await this.deps
      .wsl(
        spec.distro,
        `git -C ${shq(spec.baseClone)} worktree remove --force ${shq(spec.worktree)} 2>/dev/null || true\n` +
          `git -C ${shq(spec.baseClone)} branch -D ${shq(`sandbox/${spec.slug}`)} 2>/dev/null || true`,
        { timeoutMs: GIT_TIMEOUT_MS }
      )
      .catch(err => {
        log.warn({ worktree: spec.worktree, err: lastLine(err) }, 'sandbox.down.worktree_failed');
      });
    log.info({ project: spec.project }, 'sandbox.down');
  }

  /**
   * Answer the reap's questions about a worktree from INSIDE the distro — a host
   * stat of a distro path never sees it. `HEAD --not --remotes` is
   * upstream-config independent: it counts commits on no remote ref at all.
   * Throws when the probe answers with neither marker set (a broken git, a
   * missing distro), so the caller fails closed rather than reading "clean".
   */
  async inspectWorktree(distro: string, worktree: string): Promise<WorktreeInspection> {
    const wt = shq(worktree);
    const { stdout } = await this.deps.wsl(
      distro,
      `if [ ! -e ${shq(`${worktree}/.git`)} ]; then echo ${WT_MISSING_MARKER}; exit 0; fi\n` +
        `echo "${WT_DIRTY_MARKER}$(git -C ${wt} status --porcelain | wc -l)"\n` +
        `echo "${WT_UNPUSHED_MARKER}$(git -C ${wt} rev-list --count HEAD --not --remotes)"`,
      { timeoutMs: GIT_TIMEOUT_MS }
    );
    const lines = stdout.split('\n').map(l => l.trim());
    if (lines.includes(WT_MISSING_MARKER)) return { exists: false, dirty: false, unpushed: false };
    // A marker with no digits after it (git printed an error instead of a count)
    // is NOT zero — it is an unanswered question, and the caller holds the row.
    const count = (marker: string): number | undefined => {
      const raw = lines
        .find(l => l.startsWith(marker))
        ?.slice(marker.length)
        .trim();
      return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
    };
    const dirty = count(WT_DIRTY_MARKER);
    const unpushed = count(WT_UNPUSHED_MARKER);
    if (dirty === undefined || unpushed === undefined) {
      throw new Error(
        `Sandbox worktree probe for ${worktree} answered without its markers: ${lastLine({ stdout }) ?? '(no output)'}`
      );
    }
    return { exists: true, dirty: dirty > 0, unpushed: unpushed > 0 };
  }

  private async worktreeExists(spec: SandboxUpSpec): Promise<boolean> {
    const { stdout } = await this.run(
      spec,
      'worktree probe',
      `if [ -e ${shq(`${spec.worktree}/.git`)} ]; then echo ${WORKTREE_EXISTS_MARKER}; fi`,
      { timeoutMs: GIT_TIMEOUT_MS }
    );
    return stdout.includes(WORKTREE_EXISTS_MARKER);
  }

  /**
   * Cut from origin, not from the clone's stale HEAD. The distro's own credential
   * helper has no access to these repos, so it is reset and replaced for github.com
   * by one that answers with the forwarded GH_TOKEN. The helper body is single-
   * quoted so `$GH_TOKEN` expands inside the distro, at call time.
   */
  private async fetchBase(spec: SandboxUpSpec, token: string): Promise<void> {
    const ref = `+refs/heads/${spec.baseBranch}:refs/remotes/origin/${spec.baseBranch}`;
    await this.run(
      spec,
      `fetch origin/${spec.baseBranch}`,
      `git -C ${shq(spec.baseClone)} \\\n` +
        '  -c credential.https://github.com.helper= \\\n' +
        '  -c \'credential.https://github.com.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f\' \\\n' +
        `  fetch --quiet origin ${shq(ref)}`,
      { timeoutMs: FETCH_TIMEOUT_MS, env: { GH_TOKEN: token } }
    );
  }

  private async worktreeAdd(spec: SandboxUpSpec): Promise<void> {
    await this.run(
      spec,
      'worktree add',
      `mkdir -p ${shq(spec.worktree.replace(/\/[^/]+$/, ''))}\n` +
        `git -C ${shq(spec.baseClone)} worktree add ${shq(spec.worktree)} ` +
        `-b ${shq(`sandbox/${spec.slug}`)} ${shq(`origin/${spec.baseBranch}`)}`,
      { timeoutMs: GIT_TIMEOUT_MS }
    );
  }

  /**
   * Stamp the run's identity on the WORKTREE, not the shared base clone: two
   * concurrent runs with different authors would otherwise overwrite each other
   * between `add` and `commit`. Idempotent; a re-`up` re-asserts.
   */
  private async stampIdentity(
    spec: SandboxUpSpec,
    identity: { email: string; name?: string }
  ): Promise<void> {
    const lines = [
      `git -C ${shq(spec.baseClone)} config extensions.worktreeConfig true`,
      `git -C ${shq(spec.worktree)} config --worktree user.email ${shq(identity.email)}`,
      ...(identity.name
        ? [`git -C ${shq(spec.worktree)} config --worktree user.name ${shq(identity.name)}`]
        : []),
    ];
    await this.run(spec, 'git identity', lines.join('\n'), { timeoutMs: GIT_TIMEOUT_MS });
  }

  /**
   * The handshake the repo's entrypoint reads (design D5): the slug, the three
   * fixed in-container ports, and the database host. The repo names its own
   * database (D3), so `db_name` is not here.
   */
  private async writeHandshake(spec: SandboxUpSpec): Promise<void> {
    const handshake = {
      slug: spec.slug,
      frontend_port: 3000,
      backend_port: 8123,
      db_port: 5432,
      db_host: 'db',
      offset: null,
    };
    await this.run(
      spec,
      'handshake',
      `cat > ${shq(`${spec.worktree}/.worktree-ports.json`)} <<'ARCHON_HANDSHAKE'\n` +
        `${JSON.stringify(handshake, null, 2)}\n` +
        'ARCHON_HANDSHAKE',
      { timeoutMs: GIT_TIMEOUT_MS }
    );
  }

  /**
   * Inside the distro, for the bind mounts (see the file header). Compose reads
   * the `${…}` placeholders in both files from this environment.
   */
  private async composeUp(spec: SandboxUpSpec): Promise<void> {
    const files = [spec.composeBase, ...(spec.composeOverlay ? [spec.composeOverlay] : [])];
    await this.run(
      spec,
      'compose up',
      `mkdir -p ${shq(`${spec.metaDir}/artifacts/runs`)} ${shq(`${spec.metaDir}/logs`)}\n` +
        `docker compose -p ${shq(spec.project)} ${files.map(f => `-f ${shq(f)}`).join(' ')} up -d --wait`,
      {
        timeoutMs: COMPOSE_UP_TIMEOUT_MS,
        env: {
          ARCHON_RUNNER_IMAGE: spec.image,
          ARCHON_WORKTREE: spec.worktree,
          ARCHON_BASE_CLONE: spec.baseClone,
          ARCHON_SCRIPTS: spec.scriptsDir,
          ARCHON_META_DIR: spec.metaDir,
          GH_TOKEN: spec.secrets.GH_TOKEN ?? '',
          ANTHROPIC_API_KEY: spec.secrets.ANTHROPIC_API_KEY ?? '',
        },
        onLine: this.deps.onLine,
      }
    );
  }

  /** The repo's one command, as the agent user, with open egress. */
  private async provision(spec: SandboxUpSpec): Promise<void> {
    await this.exec(
      spec,
      'provision',
      ['agent', 'bash', '-lc', spec.provision],
      PROVISION_TIMEOUT_MS
    );
  }

  /** After provisioning, as root (NET_ADMIN). Fail-closed: a failure fails `up`. */
  private async firewall(spec: SandboxUpSpec): Promise<void> {
    await this.exec(
      spec,
      'firewall',
      [
        '--user',
        'root',
        'agent',
        'bash',
        '-lc',
        'bash /usr/local/bin/init-firewall.sh /etc/archon/allowlist.txt',
      ],
      FIREWALL_TIMEOUT_MS
    );
  }

  private async run(
    spec: SandboxUpSpec,
    step: string,
    script: string,
    opts: RunOptions
  ): Promise<ExecResult> {
    try {
      return await this.deps.wsl(spec.distro, script, opts);
    } catch (err) {
      throw new Error(`Sandbox up failed at ${step} for ${spec.project}: ${lastLine(err)}`);
    }
  }

  private async exec(
    spec: SandboxUpSpec,
    step: string,
    tail: string[],
    timeoutMs: number
  ): Promise<void> {
    try {
      await this.deps.docker(['compose', '-p', spec.project, 'exec', '-T', ...tail], {
        timeoutMs,
        onLine: this.deps.onLine,
      });
    } catch (err) {
      throw new Error(`Sandbox up failed at ${step} for ${spec.project}: ${lastLine(err)}`);
    }
  }
}

// --- Default runners -------------------------------------------------------

/**
 * Spawn a child, stream its output line by line, and resolve like `execFile`
 * would: rejects on a non-zero exit or a timeout with `stdout`/`stderr`/`code`
 * attached, so the same error readers work on both.
 */
export function runStreaming(
  command: string,
  args: string[],
  opts: RunOptions & { env?: NodeJS.ProcessEnv }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const pending = { out: '', err: '' };
    const feed = (key: 'out' | 'err', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (key === 'out') stdout += text;
      else stderr += text;
      if (!opts.onLine) return;
      pending[key] += text;
      const parts = pending[key].split('\n');
      pending[key] = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.replace(/\r/g, '').trimEnd();
        if (line) opts.onLine(line);
      }
    };
    child.stdout?.on('data', (c: Buffer) => {
      feed('out', c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      feed('err', c);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      reject(Object.assign(err, { stdout, stderr }));
    });
    child.on('close', code => {
      clearTimeout(timer);
      for (const key of ['out', 'err'] as const) {
        const line = pending[key].replace(/\r/g, '').trimEnd();
        if (line) opts.onLine?.(line);
      }
      if (timedOut) {
        reject(
          Object.assign(new Error(`${command} timed out after ${opts.timeoutMs} ms`), {
            stdout,
            stderr,
            code: 'ETIMEDOUT',
          })
        );
      } else if (code !== 0) {
        reject(
          Object.assign(new Error(`${command} exited with code ${code}`), { stdout, stderr, code })
        );
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * `wsl.exe -d <distro> --exec bash -c <script>`. Only WSLENV-named variables
 * cross into the distro, so every entry of `env` is listed there (`/u` =
 * Windows → WSL only).
 */
export function defaultWslRunner(
  distro: string,
  script: string,
  opts: RunOptions
): Promise<ExecResult> {
  const names = Object.keys(opts.env ?? {});
  const wslenv = [process.env.WSLENV, ...names.map(n => `${n}/u`)].filter(Boolean).join(':');
  return runStreaming('wsl.exe', ['-d', distro, '--exec', 'bash', '-c', script], {
    ...opts,
    env: { ...(opts.env ?? {}), WSLENV: wslenv },
  });
}

/** The Windows docker CLI, which drives the same daemon the distro's does. */
export function defaultSandboxDocker(args: string[], opts: RunOptions): Promise<ExecResult> {
  return runStreaming('docker', args, opts);
}
