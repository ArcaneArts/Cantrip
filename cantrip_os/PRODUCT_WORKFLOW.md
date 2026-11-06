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
**Check recovery** observes the selected attachment without repeating work. It
reports the same runtime, a changed runtime, an unavailable OS or a changed
identity. An unavailable connection retains its last observed generation as
historical metadata while execution remains unavailable. **Verify files** then
observes the actual retained source and current generation. **New Linux agent** also performs these observations before
creating the captured placement.

An OS restart or replacement invalidates older chats' captured runtime generation.
Verify the retained source and create a new Linux agent. Automatic re-admission of
an existing chat is not implemented. A failed or disconnected OS never selects a
host directory as a fallback.

The workspace selector URL opens its independent desktop. Shell execution does
not require starting that desktop. The optional remote package supplies Linux
computer use and Cantrip's integrated desktop viewer.

## Local recovery administration

For local root administration, the optional [recovery package](packages/recovery/README.md) provides
capture, inspect, staged restore and rollback commands. Capture interrupts all
managed workspaces, and its guest spool is root-private plaintext. Use the
[Cantrip controls](#private-workspace-backups) for encrypted Worker storage.

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
limit. Remote 0.5.0 supplies integrated human takeover.

## View the assigned desktop

In **Project Settings → CantripOS**, choose **Open desktop** on the intended
source. This creates a Cantrip Remote Desktop view bound to that source's
workspace and captured binding/attachment/runtime generations. It does not move
an existing agent. The encrypted stream uses the normal authorized WorkerLink
route and shares the guest native helper with agent CUA. Model credentials stay
on the Worker.

The view starts in viewing mode while an agent operates. Choose **Take control**
to pause guest CUA and use pointer, keyboard and clipboard input. Choose **Return
to agent** to release human input; the agent can make a fresh CUA call and attach
again. Canceled operations are not replayed. Only one viewer can control the
assigned desktop, including across different saved views. Disconnecting or
suspending its surface releases that transient lease and held input. Shell work
continues independently. Closing the last viewer releases
its capture without stopping the agent or desktop; retiring the agent leaves
an attached viewer usable. Reconnect observes the same captured destination.
After an OS runtime changes, create a new view for the verified source rather
than silently following the replacement. A retired view can still be closed or
removed. Managed SSH/SFTP, VNC and TCP endpoints use the same saved source;
see the service workflows below.

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

When the Worker reconnects, Linux Run reconciliation now resumes the exact saved
native session and process rather than stopping it because Worker memory was
lost. Its definition, target, launch identity and sealed secret snapshot must
match the recorded admission. Retained output is replayed into the new Worker's
Run buffer with redaction; the command and preparation are not repeated. Missing
or changed native sessions remain unknown. Explicit Stop still owns termination.
An already confirmed completion remains recorded even if output cannot be
recovered, with an explanatory output message and truncation flag. Executor
0.10.0 reports its actual output eviction boundary. If the resumed reader has
missed output, the terminal/Run emits a notice and continues observing the same
process. Run output retains its truncation flag even after the notice scrolls
out of the output buffer. Lifecycle sequence gaps alone do not indicate loss.
Older executors display that retention coverage is unavailable on recovery;
they are not rejected merely for lacking this metadata. Native output is
bounded, and completed process history expires; no recovery action reruns a
command to recreate missing history.

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

## Forward a Linux development service

With remote package 0.7.0 installed, start the service in the intended Linux
workspace, for example `python -m http.server 3000 --bind 127.0.0.1` in its
captured Linux terminal. The service does not require a running desktop.

Open **Project Settings → Tunnels → New tunnel**. Choose the intended
**CantripOS** workspace/checkout as this tunnel's destination, enter port `3000`,
and save. Host and Linux routes share one list; Linux rows carry a CantripOS
badge. Each route keeps its own destination rather than following a global
Host/Linux selection.

In the Cantrip desktop app, start that tunnel to attach a local loopback port.
Use its displayed endpoint to open the development service; Stop disconnects
that device's attachment. Browser clients can manage definitions but do not
create local OS listeners.

A saved Linux route captures its binding, worktree and attachment/runtime
generations. Its port and data protection remain encrypted. The Server resolves
current canonical authority and the Worker opens the guest service through the
optional package. No guest port is published on the Docker host for this path.
A stale source fails without trying the same port on Host or another workspace.
An attachment also pins the remote-service generation: after remote support is
restarted, Stop and explicitly start a fresh attachment. After the OS runtime
changes, explicitly select the current workspace when editing a stopped route.

Managed SSH/SFTP and VNC are described below. Explicit forwarding from Guest to
Host is available through saved reverse routes described below.

## Managed SSH and SFTP

In **Project Settings → Tunnels**, create a route for the intended CantripOS
workspace and choose **Linux service → SSH / SFTP**. Paste one Ed25519 public
key from your SSH client and save. A normal public-key comment is accepted;
private keys stay on your computer. SSH routes share the ordinary tunnel list
and retain their own captured workspace. They do not need a destination port or
a running desktop.

In the Cantrip desktop app, start the route and open its **SSH connection
details** action. It provides SSH/SFTP commands for macOS/Linux and PowerShell,
the selected account and the actual host-key fingerprint. The app writes an
independent temporary public `known_hosts` pin for this exact local forward.
The commands use that file, `HostKeyAlias`, `StrictHostKeyChecking=yes` and
`GlobalKnownHostsFile=none`; they
do not replace your global SSH configuration. Use your normal SSH agent/default
key, or add `-i <matching-private-key-path>` to the copied command.

Login starts in the captured account's home. The account has unrestricted
`sudo -n`, as in ordinary CantripOS terminals. SFTP uses the same account and
filesystem. SSH passwords, other accounts and SSH's own agent/port forwarding
are disabled for this managed connection; explicit Cantrip development-service
routes remain separate. Stop/retirement closes its sessions and removes the
client's temporary host pin. Reconnection cannot adopt another SSH host key or
account within the same local attachment.

## Managed VNC compatibility

First open the intended workspace's desktop from **Project Settings → CantripOS**.
Create a tunnel with that exact **CantripOS** destination and choose **Linux
service → VNC desktop**. No guest port, display number or VNC password is needed.
The route captures the running workspace desktop when its attachment starts;
it cannot follow a replacement desktop or fall back to the personal/Host display.

In the Cantrip desktop app, start the route and open **VNC connection details**.
Use the displayed local **Host** and **Port** fields in your VNC client. Port
syntax varies by client; use its separate fields where available. The browser
app can manage the saved route but cannot create a local TCP listener.

Connecting a VNC client takes the same exclusive human-control lease as the
integrated viewer. Pending agent input is canceled and held input released
before the connection is admitted. The integrated viewer displays **Human
controlling**; another viewer or VNC client cannot also control that desktop.
Other workspace desktops remain independent. Closing the VNC client or stopping
its tunnel releases held VNC input and returns control to the agent. Existing
agent CUA sessions are retired; fresh authorized CUA calls can continue.

Unconfirmed guest cleanup keeps the old human-control lease blocked. A verified
remote-manager/desktop replacement fences the old helper before it is released.
After a remote-manager restart, Stop and explicitly start a fresh attachment;
a pinned old attachment cannot reconnect to the replacement. SSH and ordinary
TCP services remain independent of desktop start/stop.

## CantripOS to Worker Host

In **Settings → Tunnels**, create a route and choose its project. Set **Direction**
to **CantripOS → Worker Host**, select the workspace (a single available workspace
is selected automatically), and enter a **Guest listen port** and the Host
**Destination port**. The Host is the Worker that owns that workspace. These are
per-route choices; Host, Linux service and reverse routes share one inventory.

Start this route in the browser or Native app. From that Linux workspace,
`127.0.0.1:<guest-listen-port>` reaches the configured loopback service on its
Worker Host. It does not refer to the viewing device. No Docker Host alias,
Host port publication, running guest desktop or local Native port is required.
Use a distinct guest port for each simultaneously running route in the same OS;
an occupied port fails admission rather than replacing the existing listener.

Stop closes the actual guest listener and its clients. The controlling browser
must remain connected: its WorkerLink control lease keeps the Worker-owned
bridge alive. Losing it retires the bridge; start again explicitly. Saved source
captures do not follow an OS replacement automatically. Stop attachments before
editing a route; the server checks again while holding its mutation lock, so
an attachment admitted concurrently cannot be silently changed or deleted.

## Private backup backend checkpoint

Both Server implementations provide owned backup admissions and a paginated
catalogue through the [backup API](BACKUPS.md#server-admissions-and-catalogue).
Requests retain immutable operation identities and opaque intent. Repeating an
admission observes its original Worker job, including after Server restart.
Restore uses the original backup scope and a freshly selected destination;
rollback targets the original restore workspace.

Explicit continuation can activate an already received archive after executor
restart, using a separately recorded runtime authorization. It cannot change
the instance, attachment, account or Worker. File restoration leaves source
rebinding and captured chats deliberate. The following controls build on this API.

## Private workspace backups

Open **Project settings → CantripOS**, select an instance/workspace and use
**Private backups**. Unlock the account's encryption first. **Capture workspace**
uses an optional private label and explicit home-relative exclusions, one per
line. Ignored files are otherwise included. Capture, restore and rollback
interrupt managed work across the instance's workspaces; they do not back up
running processes or open windows. The ordinary personal desktop is independent.

**Backups and operation history** is an owned, paginated list across destinations.
Each item identifies its instance, workspace and Worker. Private labels, manifests,
exclusions, diagnostics and restore receipts are authenticated/decrypted only in
the unlocked client. Completion is historical: an offline storage Worker or an
unchecked archive is displayed separately from the saved result.

**Restore backup** defaults to a new empty workspace. Its account-creation
operation is retained before sending and the actual creation receipt is required;
an existing account with a matching name is not adopted. The destination must
use the same storage Worker. Replacing an existing workspace requires selecting
it and checking the explicit replacement choice. Data is fully authenticated and
staged before activation. **Roll back restore** uses its retained original and
requires a separate confirmation. Browser data may require signing in again.

An encrypted immutable admission is saved in this tab before submission. After a
lost response or reload, **Resume saved request** submits that same admission;
Server observes its original job. **Discard local draft** only clears the tab's
copy and does not cancel admitted work. Closing the tab can lose that local draft,
but already admitted operations remain in Server history. No automatic mutation
retry is used for connection or CSRF recovery.

**Observe outcome** reads the original job. **Recover interrupted operation**
reconciles durable guest/archive evidence. **Continue staged operation** explicitly
authorizes the freshly observed runtime to finish known staging on the same
attachment/account. It does not recapture, repeat uncertain uploads or replay an
unknown directory exchange. Existing chats and handles retain their placement;
refreshing an instance does not redirect them.

Authorization uses the existing repository-content grants. Actual Worker refresh
loads all still-active historical revisions; an archive's revision is read from
its authenticated file, never inferred from the response envelope. Revoked
historical grants are not silently recreated. Missing keys or a corrupt archive
fail the actual restore rather than falling back to plaintext or the Host.

Restoring files does not automatically register project sources or redirect old
chats. Select the restored workspace, choose **Register existing or restored
Linux files**, and enter the restored directory relative to its Linux home.
For a home-contained source, retain its original relative path, such as
`checkouts/<original-source-id>`. The private restore receipt identifies extra
roots relocated beneath `.cantrip-restored-sources-<restore-operation-id>`.

**Register existing source** reserves fresh source/worktree/binding identities
and verifies the actual files without cloning or moving them. A Git project
requires its repository root. Once the source is ready, **New Linux agent** opens
a freshly bound chat; Explorer, editor, terminal and per-configuration Run
destinations use that source. The original chats remain bound to the original
workspace. See [source registration](SOURCES.md#register-existing-or-restored-files)
for retry and path semantics.

The actual Docker browser acceptance covers restore, registration, file editing,
Linux terminal and Run execution through the full Server/Worker. Agent creation
captures the restored source, but current-runtime model acceptance is still
outstanding. Separate native Controller tests cover Git registration and a new
secondary worktree in Docker and the installed VM; they do not substitute for
full installed-system product or real remote/cloud acceptance. Phase 5 remains
in progress.

## Retained instance power

The [lifecycle API](INSTANCE_LIFECYCLE.md#server-owned-power-admissions) now supports
owned Docker start/stop/restart and retained operation history through Server and
Worker. In Project Settings → CantripOS, select the instance and use Instance
power. Existing attachments can discover their supported carrier with Check
recovery. Confirm start, stop or restart explicitly; these affect every workspace
in the shared OS. Ordinary refresh and Check recovery cannot make an
unresolved power operation executable. A delayed observation from before a power
transition cannot restore availability after it completes either.

Power observation can recover the original receipt without repeating an uncertain
mutation. Running at the Docker carrier level does not imply the guest helper,
project sources or desktop are ready. After restart, use the explicit recovery and
source verification paths before opening fresh work; old chats keep their captured
placement. SSH alone supplies no powered-off-machine control capability.

If a reply is lost, retain the saved request and use Observe saved request. Reload
preserves the original admission in this browser session; it does not repeat the
mutation. Power history supports older admissions and pagination. Dismissing a
saved reminder does not cancel the operation. Current carrier state and Linux
readiness are shown separately, including when a historical operation completed.

After explicit recovery, verify the intended source and open fresh work. Old
terminals, Run generations and chats retain their captured runtime. The file
sidebar follows a selected Linux desktop's source, including while its old runtime
is unavailable. It never treats a missing desktop query as a Host selection.

## Workspace desktop lifecycle

Server-owned [desktop lifecycle APIs](INSTANCE_LIFECYCLE.md#server-owned-desktop-admissions)
admit an individual workspace desktop transition and retain its history in both
Server implementations, with Worker/native routing. In **Project Settings →
CantripOS**, select the instance and Linux workspace. **Workspace desktop** shows
its observed state and offers **Refresh desktop**, **Start desktop**, **Stop
desktop** and **Restart desktop**. Confirm the selected action and destination.

Stopping or restarting a desktop closes its graphical applications. Retained
files, independent terminals/Run processes and other workspace desktops remain
available. The operation does not replace the executor runtime or redirect the
source. Existing desktop views and computer-use handles retire with that desktop;
use **Open desktop** on the intended source to obtain fresh viewing authority.
SSH/TCP services remain independent. A VNC connection belongs to its captured
desktop and must reconnect with fresh authority after replacement.

If a response is lost, use **Observe saved request**. The original request is
saved before submission and survives a reload in this browser session. Observation
reads the same operation instead of issuing another transition. **Desktop history**
shows earlier operations and supports pagination and observation. Dismissing a
saved reminder does not cancel the operation. Historical completion and the
currently observed desktop state are separate.

Observe the intended workspace desktop to obtain an opaque current target, then
retain the entire create request before submitting it. Recover the same operation
through its observe endpoint after an uncertain response. Repeating create observes
the original admission; it does not restart a desktop again. Changed actual targets
need an explicit new observation and a distinct admission. Historical completion
does not imply a current viewer or fresh computer-use authority.

## Terminal recovery after Worker loss

When the Worker or its transport disconnects, an interactive Linux terminal may
show an unknown outcome. **Reconnect to Linux** resumes its recorded native
session during the executor's configured recovery window; it does not repeat the
shell startup or typed commands. Run reconciliation likewise observes its
recorded process. Explicit terminal close and Run cancellation still terminate
their intended work.

Executor 0.11.0 defaults to a 24-hour detached-session window, configurable by
root in `/etc/cantrip-os/executor.json`. Output retention is bounded separately;
the terminal or Run output reports known missing history. See the
[executor guide](packages/executor/README.md) for configuration and expiration.
Guest/executor restart ends those processes and creates a fresh runtime. Use
**Check recovery**, verify the intended source and open fresh work after that
transition. Existing chats retain their original placement.
