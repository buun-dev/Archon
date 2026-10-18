---
title: Container Isolation
description: Run folder-project workflows inside an overlay-isolated Docker container with governed, approval-gated write-back to the live root, or a repo project's runs inside a per-run WSL2 sandbox.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 12
---

[Folder projects](/getting-started/concepts/#folder-projects) — directories with or without git, where Archon applies no git machinery — run **in place** at the live root by default: every write lands immediately. That is honest but ungoverned, and unsafe for unattended automation against real client data. **Container isolation** runs the whole workflow inside a Docker container over a **read-only mount of the project root plus a writable overlay upper layer**, so nothing touches the live folder until you approve it.

The overlay backend is folder-project-only. Repo projects use [git worktrees](/book/isolation/) by default; a repo can instead run each worktree inside a per-run WSL2 sandbox, described in [Repo projects (WSL sandbox)](#repo-projects-wsl-sandbox).

## How it works

```
prepare → container (root mounted read-only, overlay upper on a per-run volume)
   claude + bash/script nodes all run INSIDE via `docker exec`
   env = the Archon-managed bag + auth only (never the host process.env)
        │
   … approval gate?  →  docker stop (0 RAM while paused)  →  approve/resume → docker start
        │
   nodes done → WRITE-BACK GATE: overlay diff summarized, run pauses
        │
   approve → diff applied to the live root → run completed
   reject  → diff discarded, live root untouched → run completed (noted)
        │
   teardown → container + volume removed
```

The overlay's upper layer **is** the diff by overlayfs construction, so computing what changed is a directory walk, not a tree comparison. Claude nodes run via the SDK's `spawnClaudeCodeProcess` hook into `docker exec`; `bash:`/`script:` nodes exec in the same container rather than silently falling back to host execution.

## Prerequisites

1. **Docker** running on the host (Engine ≥ 20.10 / Docker Desktop).
2. **The runner image**, built once from the in-repo Dockerfile:

   ```bash
   bun run build:runner-image
   ```

   This tags `archon-runner:<version>` and `archon-runner:latest` (the default). It bakes in the Claude native binary, git, bash, bun, uv, and `fuse-overlayfs`.

## Running

```bash
# Register the folder + run in a container in one go
cd /path/to/ops-root
bun run cli workflow run my-workflow --folder --container "reorganize the invoices"
```

You'll see the container come up, nodes execute inside it, and — when the run finishes with changes — a **write-back gate**:

```
Container run finished — review before applying to the live folder.
7 file(s) changed (3 added, 3 modified, 1 deleted):
  + invoices/2026-06/summary.md
  ~ invoices/index.md
  - invoices/stale.tmp
  … and 3 more
Approve to APPLY these changes to the live folder, or reject to discard them.
```

Drive it like any other pause:

```bash
bun run cli workflow approve <run-id>   # apply the diff to the live root, then complete
bun run cli workflow reject  <run-id>   # discard the overlay, live root untouched, complete
```

An **empty diff** skips the gate and completes silently. Set `container.write_back: auto` on a workflow to apply without pausing (logged, for unattended jobs).

## Pause economics

Any pause — an approval/interactive gate mid-run, or the write-back gate at the end — **`docker stop`s the container**. A multi-day wait costs ~0 CPU/RAM. Approve/reject/resume rediscover the container by its `diy.archon.env-id` label and `docker start` it (or recreate one over the persisted upper volume if the container is gone). If the volume itself is gone — the only place the un-applied work lived — resume **fails loudly** rather than silently restarting from an empty overlay.

Container pauses are only resumable **from the CLI**, where the Docker backend is wired. Approving or rejecting a container run from chat or the Web UI records the decision but cannot continue the container. The run stays paused until you run `archon workflow resume <run-id>` from the CLI in the same project. Do not re-send the decision: the gate is already resolved.

## Selection and configuration

Precedence: `--container` flag > workflow `container.enabled` > config `container.enabled` > off. See [configuration](/reference/configuration/#container-isolation-folder-projects) for the `container:` config block (image, network, memory, pids) and the `container.write_back` workflow policy.

`archon isolation list` shows active container environments (a paused run's container appears here with its age and is **never** auto-pruned); `archon isolation cleanup` reaps the containers + volumes of terminal or orphaned runs older than the threshold.

## Provider support

| Provider | In-container | Notes |
|----------|:---:|-------|
| **Claude** | ✅ | Spawns its CLI via `docker exec`; the binary is baked into the runner image. |
| **Codex** | 🔜 | Needs an in-container spawn of `codex app-server` + the binary in the image; `CODEX_HOME/auth.json` on the upper volume. Fails fast today via the `containerExec` capability. |
| **Pi** | 🔜 | In-process harness; needs a container tool-transport (Flue-style) or an in-image shim. |
| **OpenCode / Copilot / community** | 🔜 | Declare `containerExec: true` and implement their own exec-in-container translation against the `ExecutionContext` contract. |

A non-Claude node in a container run **fails fast before any node executes**, naming the provider and the `containerExec` capability — never a silent host escape.

## Security posture

The container is the isolation boundary: read-only lower bind + overlay upper on a VM-local volume + Archon-managed env only (the host `process.env` never crosses) + approval-gated write-back. The apply is the **one** moment the live root is written.

Overlay mount mode is chosen least-privilege-first: `fuse-overlayfs` (only `--device /dev/fuse`, no `CAP_SYS_ADMIN`) is attempted first and works on rootless / userns-remap daemons; a standard rootful daemon falls back to `native` (kernel overlay + `CAP_SYS_ADMIN`), which lets in-container root remount the read-only lower — so `native` is isolation-hardening, **not** a sandbox against a hostile agent. The full threat model, the `native` caveat, and the `docker exec -e` secrets-in-`ps` limitation are documented in `packages/isolation/docker/SECURITY.md` — read it before running untrusted work.

Two Archon-owned host directories are bound into the container at their host paths: the run's frozen workflow source, read-only, and `$ARTIFACTS_DIR`, read-write. The artifacts bind is what lets an in-container node leave screenshots, reports, or the `evidence_policy` marker where the engine and the operator read them. It is the only host directory the container can write; its contents are run output and the host never executes them. On a rootful Linux daemon the container's root user owns what it writes there, so Archon hands the directory back to the host user when the container is suspended or destroyed.

Before a named script or other capture-backed read is dispatched, Archon hashes the host capture and compares it with the run's pinned source identity. This refuses a mismatch present at that checkpoint; it does not close the check-to-exec race, contain a same-UID host process, or cancel parallel nodes already running.

## Repo projects (WSL sandbox)

A repo project selects the sandbox with `isolation.provider: container` in its own `.archon/config.yaml`, not with `--container`: `--container` drives the folder backend above and refuses a repo project. Each run then gets its own git worktree inside a WSL2 distro and a Docker Compose stack around it: Archon's agent service, plus whatever services the repo's compose overlay declares. The repo's `isolation.provision` command readies the worktree inside the fresh container. See [configuration](/reference/configuration/#container-isolation-repo-projects) for the repo's `isolation` section and the machine's `isolation.container` section.

It needs a Windows host with WSL2 and Docker Desktop, plus:

- the WSL distro named by `isolation.container.distro` (default `Ubuntu`);
- a clone of the repo inside that distro, under `isolation.container.repoRoot`, which the sandbox cuts its worktrees from;
- the runner image named by `isolation.container.image` on the Docker daemon;
- three shared cache volumes: `archon-playwright` (Playwright browsers), `archon-uv` and `archon-bun` (package caches). Archon's compose file declares them `external: true` so a teardown's `compose down -v` can never delete them, which also means compose never creates them. Create them once per machine, owned by uid 1000 (the agent's user), with any small image:

  ```bash
  docker volume create archon-playwright
  docker volume create archon-uv
  docker volume create archon-bun
  docker run --rm -v archon-playwright:/p -v archon-uv:/u -v archon-bun:/b alpine chown 1000:1000 /p /u /b
  ```

A dispatch whose provider is misspelled, or whose machine lacks the distro, the clone or the image, is refused before any run, worktree or stack exists, and the error names the setting to correct. The preflight does not check or create the volumes: a missing one fails the run's `compose up`, after its worktree is cut, and the run tears down what it made.

The repo must gitignore `.worktree-ports.json`. The sandbox writes that handshake file into every worktree, and an untracked file counts as uncommitted work: without the ignore entry every sandbox looks dirty, so cleanup, abandon and cancel keep it forever.

Each run cuts a fresh `sandbox/<slug>` branch from the base branch. `--branch`, `--from` and PR checkouts are refused. So is a workflow with a durable wait, because a continuation cannot rewire the container, and a workflow with a `workflow:` sub-run (fan-out included), because a child run would execute on the host, outside the container. Only providers with the `containerExec` capability run inside it, which today means Claude (see [Provider support](#provider-support)).

After provisioning, a default-deny egress firewall clamps the agent before any node runs. A stopped stack loses its firewall rules, so every resume applies the firewall again after starting the stack, and a resume whose firewall fails is refused with the run left as it was. Egress stays closed while the firewall is applied, including on a resume. Dotted names outside the allowlist are answered NXDOMAIN locally; allowlisted hostnames and their subdomains resolve, and bare compose service and container names still go to Docker's resolver. Only the sandbox's dnsmasq reaches Docker's resolver. Besides allowlisted hosts, the agent reaches only its own stack's network (the repo overlay's services), never that network's gateway, the WSL host or the LAN. The allowlist is enforced by address, so a CDN front IP shared by an allowlisted host also serves other sites on that CDN. The runner image must include dnsmasq, iptables, ipset and procps (`pkill`/`pgrep`); without dnsmasq the firewall refuses, so the sandbox does not come up or resume. An overlay that joins `agent` to more than one network is refused, and so is an agent with an IPv6 address.

A run that completes or fails, or is interrupted with Ctrl-C, **stops** its stack, so the agent and the repo's services give their memory back. The worktree and its branch stay: they are the run's output. A paused run keeps its stack, and the engine stops only the agent while the run waits. `archon isolation cleanup` reclaims the sandboxes of finished runs, and `archon isolation reap` does the same for container environments only, with a JSON report for schedulers; `archon isolation remove <env-id>` removes one sandbox on demand (`--force` discards held work). Cleanup and reap never delete a sandbox that holds uncommitted changes or unpushed commits, and neither do `workflow abandon`, `workflow cancel` or `/reset`: they stop its stack and report how to release the work (see [`isolation cleanup`](/reference/cli/#isolation-cleanup-days)).

### Launch from the CLI only

Only `archon workflow run` provisions a sandbox, and only the CLI continues a sandbox run: `archon workflow resume`, and `approve`, `reject`, `respond` and `answer`, which resume inline. Every other surface refuses a repo whose config sets `isolation.provider: container`, rather than running it on the host:

- a workflow dispatched from chat or the Web UI, foreground or background, fresh or continued;
- a resource start or trigger, refused when it is prepared (no run is created) and again when it starts, in case the repo switched to the sandbox while the request waited;
- `/worktree create`.

`archon serve` and `archon workflow wake` do not continue a sandbox run either: they report it unavailable. A gate answered with `--json`, or from chat or the Web UI, stays paused until `archon workflow resume <run-id>` runs from the CLI.

## macOS / Linux notes

The overlay upper/work dirs live on a VM-local named volume, never a host bind mount (a host-bind upperdir hits `EACCES` on macOS). The merged overlay is mounted at the **same absolute path** as the host cwd, so `working_path` and every path substitution are unchanged inside the container. On a standard Docker Desktop / rootful Engine daemon, expect the `native` (CAP_SYS_ADMIN) overlay mode.
