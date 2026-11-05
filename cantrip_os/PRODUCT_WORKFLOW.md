# CantripOS project attachment

The client supports executor attachment, source provisioning, captured agent
placement, file/editor/Explorer operations, interactive Linux terminals, Run
configurations with per-configuration destinations and safe deletion, attachments
and returned artifact links. Executor 0.9.0 adds explicit GUI launches on the
assigned desktop. Docker, live/installed ISO and package lifecycle results are
recorded in [acceptance](ACCEPTANCE.md#phase-3-acceptance-and-distribution-2026-11-04). Host-only
Run/worktree/task-creation MCP adapters remain unavailable in Linux sessions;
use the source-aware product workflows described below.

## Attach and select

1. Start an executor-enabled OS from the repository root:
   `pnpm os`. The optional executor is included by default. Keep the printed
   workspace-selector URL.
2. Open a project in Cantrip, then **Project Settings → CantripOS**.
3. Choose **Attach OS**, the existing worker, and **Docker on this worker**.
   Enter the actual container name (`cantrip-os` by default), then
   **Inspect and attach**. The worker observes the actual guest identity.
4. For an installed Linux machine choose **Installed Linux over SSH** instead.
   Enter its host, port, user, and absolute worker-local identity/known-host file
   paths. These refer to existing worker files; the client does not upload keys
   or disable host verification. Passwordless sudo is required for package control.
5. Create a workspace ID or choose an existing workspace. The UI shows its actual UID.
6. Add a project source using one of the modes below. Wait for its saved state to
   become `ready`, then choose **New Linux agent**. The Server captures that
   source and generations in a new pinned agent chat. Existing chats are not moved.

**Linux-owned** creates an independent persistent checkout, or an empty folder
for a non-Git project. Git sources require a repository URL and exact commit SHA;
Git authentication must already work inside Linux. Repository access details are
sealed to the worker using the existing repository-content encryption.

**Link a worktree** chooses an exact worker-owned worktree on that worker. The
mount lifecycle recreates Docker and interrupts its running sessions. Persistent
homes, sources, and dependency data are retained. Dependency directories entered
one per line, such as `node_modules` and `.venv`, use separate Linux volumes and
are shown on the source card. Other files remain shared, including ignored files.
The original worker keeps Git ownership; the guest's host `.git` pointer is not
rewritten or made usable by mounting unrelated repositories.

## Uncertain operations and restarts

Provisioning retains one prepared operation identity across manual retries.
**Observe outcome** asks for the existing admitted operation; it does not clone
or mount again. A saved completion is distinct from current availability.
**Refresh OS**, then **Verify files**, observes the actual retained source and
current generation. **New Linux agent** also performs these observations before
creating the captured placement.

An OS restart or replacement invalidates older chats' captured runtime generation.
Verify the retained source and create a new Linux agent. Automatic re-admission of
an existing chat is not implemented. A failed or disconnected OS never selects a
host directory as a fallback.

The workspace selector URL opens its independent desktop. Shell execution does
not require starting that desktop. The optional remote package now supplies Linux
computer use; Cantrip's integrated desktop transport remains in progress.

## Agent computer use

Enable **Settings → Computer Use → Enable computer use**, then start a new turn
in a current Linux agent. Its normal `cantrip_cua/js` tool opens the assigned
workspace desktop on first use. Follow the tool's Linux instructions to inventory
and attach that display, capture it and dispatch input. Launch Chromium, Mousepad
or other applications with `cantrip-desktop` in the ordinary Linux shell.

The chat keeps its captured source and workspace. Opening a viewer does not
retarget it. The Worker shares one native connection for that desktop across
authorized agent/preview scopes, releasing the carrier after the last scope.
Stopping an agent releases its held input; an independent shell keeps running.
The Host Cantrip-window grant is unnecessary for the explicitly assigned Linux
display. Missing remote support, changed generations or revoked policy fail
without opening the Host desktop. Remote package 0.3.0 adds plain UTF-8 clipboard
read/write/paste, physical pointer movement and supported live desktop resizing
through the SDK. Clipboard text is limited to 1 MiB and its selection owner lasts
only for the helper/desktop lifetime; final JavaScript output retains its 32 KiB
limit. Integrated human takeover remains in progress.

## Files and editor

Select a newly created Linux agent, then use its **Files** sidebar. Opening a
file creates an immutable document view for that exact OS binding and runtime
generation. Read, edit/save, search, create, rename, delete, import, and binary
operations execute in Linux through the optional executor package. Related file
links retain that placement. Host and Linux views of a linked worktree have
separate view identities, including when their relative filenames match.

A linked worktree's ordinary source files remain the same files on both sides.
An explicit Linux dependency overlay remains guest-specific. Linked directory
commit lookups use the original worker's Git metadata. Full Git graph/history
product workflows for Linux-owned sources are not all adapted yet. Native agent
file watching is source-aware; refresh Explorer explicitly to observe external
changes.

An executor upgrade or restart does not retarget an old document. Save reports
the stale placement; retain/copy the draft, refresh/verify the source, create a
new Linux agent and reopen the file there. A completed uncertain save can be
observed by its original operation identity; an unknown save is not replayed.

Uploaded chat attachments are copied into the selected Linux workspace account's
private data directory outside the checkout. The native agent sees Linux paths;
original uploads and native model image input remain on the owning worker.
Copies are content-addressed, checked before use, and never overwrite a changed
copy during recovery. Unknown writes require inspection rather than replay.

Files returned by an OS-bound agent resolve against that chat's captured source.
Clicking a project file link opens an OS-bound document/editor using the same
worktree and generation. A stopped or changed source reports unavailable instead
of reading the similarly named file on the host. Executor 0.8.0 is required for
these attachment and file-reference operations.

## Linux terminals

Select a current Linux agent, file, Explorer, or terminal and choose **Add project
surface → Terminal**. The new **Linux terminal** captures that same source and
runtime. **Open terminal** on a Linux Explorer folder uses that folder. An
explicit host worktree target still creates a host terminal; choosing another
project does not inherit the previous project's OS placement.

Bash runs as the workspace UID in the selected guest checkout with passwordless
`sudo`. `nano`, `htop`, and `python` are preinstalled. The existing worker carries
terminal input/output and resize requests through the authenticated native
executor. It keeps its own private carrier directory; the Linux path is never
used as a host process directory. The Linux shell works while its desktop is
closed. A managed Codex console remains the worker-side native client connected
to the captured remote environment.

Closing a terminal stops its own Linux process tree, including sudo children.
Losing the carrier reports **Command outcome unknown**, keeps output visible,
and offers **Reconnect to Linux**. Reconnect observes the admitted session and
process; it never starts a replacement shell or resends uncertain input. A
completed terminal stays completed. To deliberately start another shell, create
a new terminal. An OS generation change requires a new captured resource after
refresh/verification; existing terminals are not redirected.

Terminal services and script-command discovery for Linux are reserved for the
setup/Run integration cycle. Enabling a Linux terminal service currently reports
that the delegated lifecycle is unavailable. It does not run the command on the
host. Native Finder/Explorer reveal is likewise unavailable for OS file views;
open the workspace's desktop to browse the guest folder.

OS agents use native Linux tools, configured network MCP servers, and the
worker's authenticated Cantrip MCP over loopback. The native app-server and MCP
broker stay on the owning worker; broker credentials and model keys are not
copied into Linux. The broker checks its credential and current execution lane
for each tool call, retaining existing permissions, revocation and expiry.
Only tools supported by the connected Server and this placement are advertised.
Host-only Run/worktree handlers and delegated Task creation remain unavailable
until explicit source adapters are installed. Exact Explorer/terminal targets
remain explicitly selected resources. Host computer use and CodeGraph injection
are omitted; an enabled user stdio MCP configuration reports an explicit error
rather than running locally or being copied into Linux.

## Linux-owned Git worktrees

For a Git project, open **Project Settings → CantripOS** and provision a
Linux-owned checkout. On its source card choose **New Linux worktree**, enter
an exact commit SHA, and optionally name a new branch. Leaving the branch empty
creates a detached worktree. The new worktree belongs to the same Linux source
and workspace account; it does not move Primary or create another clone.

Its ready card can open a **New Linux agent**. The Files sidebar, editor, and
new terminals selected from that surface use the worktree. The agent/terminal
header displays its Linux location. Worktrees appear under the workspace's
`worktrees/` directory, alongside its `checkouts/` directory for Primary sources.

Keep the form open after an uncertain response and choose **Continue worktree
admission** to observe the same operation. Its inputs stay captured. A ready
or unknown binding also remains visible in the source list; **Observe outcome**
reads its saved provisioning admission. A source must be verified in its current
runtime before admitting a new worktree. A changed Git common directory fails
before Git worktree creation. Existing admissions never start another mutation.

Linked checkouts retain Git ownership on their original worker. Create their
host worktrees through the existing worker workflow and link each exact
worktree explicitly. This Linux-owned creation form does not rewrite host Git
metadata. Run uses the explicit Linux source as described below; broader Git
graph/history UI integration remains later work.

## Linux Run configurations

1. Attach and verify the intended source in **Project Settings → CantripOS**.
2. Open **Run Configurations** in the project header. Host and CantripOS definitions
   share one list. Linux entries show their OS/workspace and short checkout source
   ID; there is no global Host/Linux switch.
3. Choose **New Run configuration**. When multiple destinations exist, choose
   **Host** or the intended **CantripOS** destination for that new configuration.
   A Host-only project skips this choice. Discovery, suggestions, validation and
   saved definitions use the chosen destination's Primary. The resulting ordinary
   revisioned file lives under `.cantrip/run-configurations` in that source.
4. Choose a configuration to run it on its own Primary. For an alternate target,
   use its **More options → Run in Worktree…** and select the exact worktree/path
   within that configuration's source and workspace. The active chat does not
   change its destination.

Each row and captured output tab retains its own placement. Selecting a different
configuration never redirects existing output, Start/Restart, or Stop actions.
**Edit** opens that configuration's original definition source. A lost Linux Run
offers Stop before another Start; only confirmed cleanup reports Stopped.

The Files sidebar follows the focused Run's captured target. Its files and editor
use the same Linux directory, including Linux dependency overlays. Identically
named files in Primary and an alternate worktree open as distinct documents.
Earlier Linux Run terminals gain this capture through migration `0249`.

Configuration selection is scoped to the authenticated server/account and project.
Linux entry identity additionally captures its source, workspace and generations;
equal config UUIDs on Host and Linux remain separate entries. An old selection
stays unavailable after an OS restart. Refresh and verify the OS, then explicitly
choose the current configuration from the combined list. It never selects Host
as a fallback. Existing resources retain their earlier captures.

**Delete** checks the stored definition revision, stops affected instances, then
removes the definition and their Run surfaces. For a linked checkout the definition
is shared with Host, so affected Host and Linux Runs are both stopped. Separate
checkouts remain separate even when their configuration UUIDs match. Unconfirmed
cleanup keeps the definition and captured handles; inspect the outcome and retry
explicitly. This requires executor 0.7.0 for Linux. Attachment and returned file links require
executor 0.8.0. Fresh Docker/ISO results are recorded in the final Phase 3 acceptance checkpoint.

## Explicit GUI commands

With executor 0.9.0, open the assigned workspace desktop from the workspace
selector, then run `cantrip-desktop pcmanfm .` or `cantrip-desktop xterm` in its
Linux terminal or agent shell. The command uses that account's assigned display
and the selected shell's current directory. Inherited personal-console display,
Xauthority, Wayland and D-Bus settings are replaced; the app receives a private
D-Bus session. No desktop is started implicitly. If the selected desktop is
stopped, the GUI app reports its normal display error without trying another
workspace or Host. Native process cancellation still owns the launched tree.
Ordinary shells receive no DISPLAY and survive independently when a desktop is
closed. For explicit root administration, choose the account, for example
`sudo -u ctw-work cantrip-desktop pcmanfm .`.

## Run API reference

`GET /api/projects/:projectId/cantrip-os/run-sources` returns owned binding epochs,
workspace/instance labels, availability, and logical worktree targets. Targets have
no Worker filesystem path. Their display paths identify the guest directory.

The existing lifecycle, status, and protected-output POSTs accept `osSource`.
New Runs select a binding plus binding/attachment/runtime generations. Ordinary
Run uses `targetWorktreeId: null`; worktree Run supplies its exact ID. Existing
tabs use `osSource: { kind: "runtime", runtimeId }`. Status can load one owned
runtime by `runtimeId` without resolving the current default source. The Server
resolves guest paths, accounts, and transports. Host requests omit `osSource`.

Definitions use
`POST /api/projects/:projectId/cantrip-os/bindings/:bindingId/run-definitions`.
The body contains binding, attachment, and runtime generations plus a shared
`project.run-configuration-definitions.*` request without `sourcePath`.
The Server resolves definition Primary within that source and workspace.
Retain the same operation UUID and request after an uncertain write. The client
and Worker retain this admission for observation rather than starting another
mutation. A changed source epoch fails before dispatch.
