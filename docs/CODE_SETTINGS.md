# Global Cantrip Code settings

Cantrip exposes the graphical Code OSS settings editor under **Settings →
Code**. The surface is global: it does not require a project, repository, or
worktree, and it uses a dedicated folderless Cantrip Code session.

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
   authenticated, origin-bound readiness message. It then invokes
   `workbench.action.openSettings` through the authenticated Cantrip workbench
   bridge.
6. The settings workbench remains mounted and connected after the user changes
   Cantrip Settings tabs. Returning to Code reveals the same iframe rather than
   creating another editor process or attachment.

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

The settings session uses the same editor-only presentation contract as file
editing. Activity bars, sidebars, panels, status bars, breadcrumbs, native tab
strips, the command center, layout controls, minimaps, and notification clutter
remain hidden. Cantrip's Settings navigation and synchronization status remain
visible around the embedded graphical settings editor.

The server attachment and local direct tunnel have a serialized lifecycle and
are retired exactly once when the retained Settings surface is finally
unmounted or replaced. A lost direct connection is detected by health probes;
Retry performs a worker synchronization and creates a fresh attachment without
initializing from stale local state.

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
