# Global Cantrip Code customization

Cantrip exposes the native Code OSS Settings and Extensions experiences under
**Settings → Code**. A Cantrip-owned sub-tab bar switches between them. The
surface is global: it does not require a project, repository, or worktree, and
it uses a dedicated folderless Cantrip Code session.

## Data flow

1. The app selects the preferred online worker that has Cantrip Code and
   worker encryption support.
2. On first use, the app uses the normal worker-grant flow to approve the
   worker principal when necessary and grant the `customization-content`
   component key. It also establishes the protected tunnel grant used by the
   workbench attachment.
3. The server asks that worker to synchronize the default Code profile before
   it creates the settings attachment.
4. The worker reads `User/settings.json` as JSONC, validates and normalizes the
   semantic settings object, and encrypts it locally. The server stores only
   the ciphertext envelope and revision metadata.
5. The app mounts the protected workbench iframe and waits for the
   authenticated, origin-bound readiness message. It then invokes either
   `workbench.action.openSettings` or `workbench.view.extensions` through the
   authenticated Cantrip workbench bridge.
6. Switching the inner sub-tab changes the native workbench presentation in
   place. The app keeps one iframe, attachment, worker connection, and Code
   process instead of creating parallel customization workbenches.
7. The customization workbench remains mounted and connected after the user
   changes Cantrip Settings tabs. Returning to Code reveals the same iframe.

The selected sub-tab is retained with the Settings page. Control requests are
serialized and abortable, so a stale response cannot win after rapid switching.
The requested view is reapplied after iframe reload, attachment recovery, or
worker reconnect. Changing the visible worker selector deliberately retires the
old attachment and opens the selected worker's profile.

The worker watcher debounces subsequent settings-file changes and uploads them
with compare-and-swap revision semantics. Server invalidations and reconnect
polling pull newer revisions back to authorized workers.

## Encryption boundary

Plaintext VS Code settings exist only in the worker-owned profile and in the
worker process while parsing or merging them. The app never receives settings
plaintext, and the server never parses, logs, or persists it. The protected
payload is associated with the account, default Code profile, encryption key
revision, payload domain, and canonical settings revision.

Session-owned keys and Cantrip runtime credentials are rejected during
normalization. Editor-only presentation values live in generated workspace
settings, outside the synchronized user profile, so user settings cannot
restore hidden workbench chrome.

## Initialization, backup, and conflicts

If no canonical record exists, the selected worker creates revision 1 from its
current normalized user settings. Before a different worker receives its first
server-driven overwrite, it writes `settings.pre-cantrip-sync.json` beside the
active settings file as a recovery copy.

Concurrent initialization attempts use the same top-level merge rules as later
updates. Compatible settings are combined through CAS; divergent same-key
values enter conflict state instead of overwriting the losing worker.

Choosing the canonical side of an explicit conflict also preserves the current
local edit as `settings.pre-cantrip-conflict.json` before publishing the
resolution revision and applying the canonical settings.

Workers retain a base/local/remote model and merge by top-level VS Code setting
key. Independent key changes and identical same-key changes merge
automatically. Divergent same-key edits, including deletion versus
modification, enter an explicit conflict state. The Code tab then offers two
deliberate resolutions:

- **Use synced settings** preserves the current local edit, applies the
  canonical version, and publishes the decision as a new canonical revision.
- **Keep this worker's settings** publishes the local version as a new
  canonical revision.

There is no blind last-write-wins path.

## Presentation and lifecycle

The Settings sub-tab uses the editor-only presentation contract. The Extensions
sub-tab retains the native primary Extensions sidebar and editor details while
still hiding the activity bar, title bar, status bar, panel, auxiliary sidebar,
native tab strip, breadcrumbs, command center, navigation and layout controls,
and unrelated notification clutter. Native extension dialogs, progress, errors,
and reload or extension-host restart prompts remain available.

An encrypted Settings conflict overlays only the Settings sub-tab. Extensions
remain usable because extension state is worker-local and is not part of the
server-side encrypted settings document.

The server attachment and local direct tunnel have a serialized lifecycle and
are retired exactly once when the retained Settings surface is finally
unmounted or replaced. A lost direct connection is detected by health probes;
Retry performs a worker synchronization and creates a fresh attachment without
initializing from stale local state.

## Extensions

Extensions are installed into the selected worker's default owner-scoped
Cantrip Code profile under `worker-data/code/profiles/<profile-key>/extensions`.
That directory survives app reloads, server reconnects, worker/editor process
restarts, and warm-profile eviction. Raw extension packages and installed
extension state are not synchronized through or persisted by the Cantrip
server.

The native Code OSS experience provides Open VSX search, extension details,
install and uninstall, global enable and disable, manual **Check for Extension
Updates**, **Update All**, prerelease selection, and **Install from VSIX**.
Microsoft Marketplace endpoints are not configured. Automatic update checking
and installation are disabled, recommendation notifications are suppressed,
and the folderless customization session does not offer workspace-only
enable/disable actions.

Use the native **Install from VSIX** action when the browser supports its file
picker. Cantrip also shows **Upload VSIX** as a bounded fallback for WebKit,
mobile, and other surfaces where that native picker cannot supply a worker-local
file. The fallback accepts one `.vsix` up to 16 MiB (the protected browser
transport's bounded request limit), sends it directly over
the authenticated attachment without server persistence, writes it to a
mode-`0600` worker temporary directory, delegates manifest validation and
installation to Code OSS, and removes the temporary directory on success,
failure, or cancellation. Worker startup recreates the private upload root,
removing crash remnants and stale symlinks without following them. The client
supplies bytes only: the endpoint accepts neither a browser-provided worker path
nor a remote URL. Cantrip reports completion or failure beside the button; Code
OSS owns any required reload/restart prompt.

`cantrip.cantrip-workbench` and `cantrip.cantrip-themes` are required runtime
extensions. Code OSS forces them enabled and rejects attempts to disable,
uninstall, downgrade, replace, import over, or install a VSIX/gallery package
with either identity. This enforcement lives below the UI and overrides stale
disabled-profile state.

Treat every third-party extension as trusted worker code. It can access files,
start or modify processes, read credentials available to the worker account,
and use the worker's network with the same practical authority as a terminal.

## Local validation

Use `pnpm devtop` and local workers only. Winterhold is not a compatible test
target for this feature.

For a fresh local state, verify that the encryption profile initializes, the
worker transitions from pending approval to ready through on-demand grants,
and Settings → Code opens without creating a project. For multi-worker checks,
run isolated worker data directories and confirm propagation, offline catch-up,
backup creation, and explicit same-key conflict resolution. Inspect server
database rows and structured logs with a unique plaintext sentinel; only the
encrypted envelope and non-sensitive revision metadata may appear.
