# Optional execution package

Phase 3 is in progress. The package supports captured project sources, native
agent execution, product file operations, interactive Linux terminals, setup/Run,
attachment/artifact delivery and explicit workspace GUI commands through the
existing worker. Final distribution acceptance remains in progress.
Installing this package alone does not move an existing chat into Linux.

`cantrip-os-executor` depends on the workspace package. It runs the pinned,
reviewed `codex-exec-server` as each selected workspace account, with its own
empty `CODEX_HOME`. It installs no worker or model-provider credentials. Source
preparation reuses the canonical Codex build with `--executor-only`; the output
omits the CLI, code-mode host, responses proxy, and V8 binary archive. The native
executor and bundled Linux sandbox helper retain their upstream protocol.

From the repository root:

```sh
node cantrip_os/scripts/executor-package.mjs
CANTRIP_OS_ARCH=amd64 node cantrip_os/scripts/executor-package.mjs
CANTRIP_OS_EXECUTOR=1 pnpm os
CANTRIP_OS_EXECUTOR=1 node cantrip_os/scripts/iso.mjs
```

Cold Rust builds take time. BuildKit caches source downloads and compilation;
ordinary theme/package edits reuse the native build. Executor inclusion defaults
to `0`; set it to `1` to include the optional integration package.
Workspace support remains enabled by default. Including the executor requires
the workspace package; apt enforces that dependency.

Output: `cantrip_os/artifacts/packages/cantrip-os-executor_0.9.0_<arch>.deb`.
It contains the source/patch fingerprint manifest, binary hashes, licenses, and
sandbox helper. Docker and ISO recipes install the same package.

Inside Linux, after copying the package there:

```sh
sudo apt install ./cantrip-os-executor_0.9.0_arm64.deb  # amd64 for the VM edition
sudo cantrip-executor enable
sudo cantrip-executor status
sudo cantrip-executor attach OWNER_ID WORKER_ID
sudo cantrip-workspaces create work
sudo cantrip-executor open work
sudo cantrip-executor close work
sudo cantrip-executor disable
sudo apt remove cantrip-os-executor
```

`open` returns a public descriptor with persistent instance ID, owning
attachment, current manager/executor generations, workspace identity and guest
location. The root-only control socket supplies the bearer capability only to
the package carrier; the descriptor does not print it. Repeated attach to the
same owner/worker is idempotent. Changing either requires explicit `detach`,
which stops managed executors but retains data.

Each native listener binds an OS-loopback ephemeral port and authenticates
every connection. Docker does not publish executor ports. The worker uses
Docker's privileged exec carrier locally, or authenticated SSH with a pinned
known-hosts file for an installed test VM. This is the execution connection,
not a general Cantrip SSH/SFTP service feature. Neither the local desktop
viewer nor its token authorizes executor access.

`cantrip-executor connect WORKSPACE --expect '<descriptor JSON>'` bridges native
JSON frames over that protected carrier. It requires the exact instance,
owner/worker, workspace and runtime generations. It does not start an executor
or select a fallback. Native `initialize`/`initialized` establishes the session;
the native session ID supports explicit reconnect. Disconnect is not process
cancellation: use native `process/terminate`. The carrier never replays requests.

The worker module `cantrip_worker/src/os-executor/connection.ts` implements the
carrier and preserves unknown delivery outcomes. Product callers must apply
server admission and project binding in later cycles. Guest paths are not
worker-local paths.

The systemd unit supervises installed systems; Docker invokes the package-owned
lifecycle. On installed systems, `enable`/`disable` also controls boot enablement,
and explicit startup waits for the actual control endpoint. Executors are
independent of desktops. Stopping a desktop leaves
these commands running. Stopping the executor manager terminates its native
servers and descendants, including detached children. A restart creates a new
generation; old process handles are not replayed on a replacement server.

Version 0.2.0 sets `CAP_KILL` on the native executor and enables reviewed Linux
process-tree cleanup for individual command cancellation. It can signal sudo
descendants and children which change session/process group while preserving
independent native jobs. Ordinary commands retain their UID and do not inherit
the capability. See the [source backend guide](../../SOURCES.md).

Configuration: `/etc/cantrip-os/executor.json`. Persistent identity, attachment,
enable preference and logs live under `/var/lib/cantrip-os-executor`, mounted
in Docker at `<instance-name>-executor`. Workspace files remain in their
existing volume. Remove/purge retain both; `os.mjs reset` explicitly deletes
all three instance volumes. Service lifecycle logs go to Docker logs or the
system journal.

The opt-in real-runtime test requires a disposable instance with `exec-a` and
`exec-b` workspace accounts and the executor package enabled:

```sh
CANTRIP_OS_TEST_CONTAINER=cantrip-os-executor-test \
  pnpm --dir cantrip_worker exec vitest run test/os-executor.integration.test.ts
```

For an installed VM, set `CANTRIP_OS_TEST_TRANSPORT` to a JSON file with `kind:
"ssh"`, `host`, `port`, `user`, `identityFile`, and `knownHostsFile`. The SSH user
needs passwordless sudo for package control. Obtain the disposable VM's host
key through its trusted console; do not disable host-key checking. The test
mutates its designated workspaces. Record runtime results in acceptance only
after actually executing them.

Version 0.3.0 added `file-operations.mjs`, a small Node child started through the
native authenticated process API. It reuses the worker's filesystem semantics
for Explorer, text/binary editing, and uploads. It has no listener, scheduler,
conversation store, account key, or provider credential. Its temporary binary
staging key is generated locally inside the workspace. Node is a declared
package dependency; removing the executor removes this integration helper.

Product file mutations record durable admissions and completion receipts. After
uncertain transport delivery, recovery observes the saved operation and reports
an unknown outcome when no completion exists. It does not resend the mutation.
Older captured editors fail after a runtime change; verify the source and open
it through a newly selected Linux agent. Their recoverable drafts remain intact.

Interactive terminals use the native process API. Reviewed patch 0047 exposes
its existing PTY resize implementation as `process/resize`, scoped to the
initialized native session's process handle. The worker keeps durable process
admissions before starting Bash and resumes known handles without replaying
input. This package does not install the worker or a terminal scheduler.

Version 0.5.0 adds `run-definitions.mjs`, a finite native child for the existing
Run definition repository, static provider/path discovery, and Linux tool
validation. It uses the actual guest account and a Debian executable search
path. The owning Worker retains admissions and observes known native processes
after uncertain delivery. No Worker environment, broker token, provider account,
or model credential is sent into this helper. Run process lifecycle integration
is a separate milestone.

Version 0.6.0 adds the finite `run-plan.mjs` preparation helper and the small
`process-owner` binary for managed Run generations. Preparation reuses shared
provider, environment-file, and live Codex environment behavior in Linux. It
receives only purpose-specific Run secret values; account and provider keys
remain on the Worker. The Worker retains native process identities, output
redaction, cancellation, and operation recovery.

The process owner runs without extra privileges, adopts orphaned descendants,
and remains alive until its command tree ends. This lets native termination
also reach detached root children after `sudo`/`setsid` forks. Ordinary commands
keep the selected workspace UID and unrestricted sudo. GCC is used only in the
package build stage. No compiler, scheduler, or new daemon is added by this
helper. This generation driver is an execution component; product Run routing
are integrated with a combined Host/CantripOS configuration list.

Version 0.7.0 adds revisioned definition deletion to the finite Linux helper.
The Server reads the actual definition revision before stopping any Run, retires
all Host/Linux runtimes that use that same source, and removes the file only after
cleanup is confirmed. A separate Linux checkout with the same configuration UUID
retains its independent source identity. Unknown cleanup preserves the definition
and captured runtime; an explicit retry observes recorded native work.

Version 0.8.0 materializes uploaded attachments in each workspace account's
private data directory outside the checkout, and resolves chat file references
inside the captured Linux source. Copies are content-addressed and checked on
reuse. A changed or uncertain copy is reported without overwriting it or
replaying an unconfirmed write. Original uploads and native model image input
remain on the worker; Linux prompts contain the guest paths.

Version 0.9.0 adds `cantrip-desktop command [args ...]`. Run it as the assigned
workspace account, for example `cantrip-desktop pcmanfm .` or
`cantrip-desktop xterm`. Open that workspace's desktop through the workspace
selector first. The wrapper looks up the account's assigned display and home,
keeps the current directory and UID, discards inherited X/Wayland/auth/session
values, and creates a private D-Bus session. Current workspace X servers use
local sockets with `-ac`, so no Xauthority cookie is required or inherited.
The actual GUI command fails normally if its display is stopped; it never starts
a desktop or uses the personal console as a fallback. Commands retain normal
native executor cancellation. Ordinary shell commands receive no DISPLAY and
continue independently of desktop lifetime. Root administration must explicitly
choose the workspace account, e.g. `sudo -u ctw-work cantrip-desktop pcmanfm .`.

For package-only iteration with an already tested native bundle, place the selected
architecture's complete runtime under `<context>/executor/` and build with:

```sh
CANTRIP_OS_ARCH=arm64 CANTRIP_OS_EXECUTOR_RUNTIME_CONTEXT=/absolute/runtime-context \
  node cantrip_os/scripts/executor-package.mjs
```

This explicit option rebuilds the shared file helpers and Debian package while
reusing that supplied bundle. It never selects a previous binary automatically.
Keep the bundle's build manifest and resources together and use the matching
architecture. Omit the option to build the pinned native source normally. Changes
to native executor code require the normal source build. This avoids waiting for
the shared compiler cache when changing only Python services, scripts or desktop
configuration; it is also usable by Docker/ISO builders through the same package
preparation function.
