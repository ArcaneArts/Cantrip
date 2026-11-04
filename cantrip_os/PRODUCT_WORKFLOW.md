# CantripOS project attachment

This checkpoint adds the client workflow for the executor, source provisioning,
captured agent placement, file/editor/Explorer operations, and interactive Linux
terminals. Setup/Run, attachment/artifact delivery and final distribution acceptance remain
in subsequent product integration work. This checkpoint is not complete Phase 3
acceptance.

## Attach and select

1. Start an executor-enabled OS from the repository root:
   `CANTRIP_OS_EXECUTOR=1 pnpm os`. Keep its printed workspace-selector URL.
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
not require starting that desktop. Cantrip's integrated desktop transport and
Linux computer use remain later work.

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
product workflows for Linux-owned sources and live file notifications remain
part of the following integration work; refresh explicitly to observe external
changes at this checkpoint.

An executor upgrade or restart does not retarget an old document. Save reports
the stale placement; retain/copy the draft, refresh/verify the source, create a
new Linux agent and reopen the file there. A completed uncertain save can be
observed by its original operation identity; an unknown save is not replayed.

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

At this checkpoint native Linux tools and configured network MCP servers are
available to OS agents. The pinned native environment cannot start worker-local
stdio MCP processes. Cantrip/CodeGraph/host computer-use MCP injection is omitted
for these sessions; an enabled user stdio MCP configuration reports an explicit
error rather than running locally or being copied into Linux. Delegated Cantrip
project tools remain part of the following integration work.

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
metadata. Run and broader Git product integration remain subsequent work.

## Linux Run definition API checkpoint

Executor 0.5.0 supports definition files and provider discovery through
`POST /api/projects/:projectId/cantrip-os/bindings/:bindingId/run-definitions`.
The body contains `runtimeGeneration` and a shared Run definition `request`
with its operation UUID and project UUID. The request uses the existing
`project.run-configuration-definitions.*` discriminator and omits `sourcePath`.
The Server resolves Primary in this binding's source and workspace; choosing a
secondary worktree does not move definition files into it or select the host.
The response identifies the resolved Primary and contains the ordinary Run
definition result. Worker/native schemas reject older unsupported command paths.

Retain the operation UUID and identical request after a lost mutation response.
The Worker observes its saved result or known native process and never starts a
replacement mutation for that admission. A changed runtime or missing Primary
binding reports an error. Provider validation checks files and executables in
Linux. Definitions remain revisioned files under `.cantrip/run-configurations`.

This is an API/package checkpoint. The header source picker and delegated Run
process lifecycle follow next; the existing header still controls host Runs.
Linux definition deletion is not admitted by this checkpoint: it must join
that lifecycle so active Runs stop before their definition and tabs are removed.
