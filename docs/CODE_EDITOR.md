# Cantrip code editor

Text files open in Cantrip's own editor in Explorer, sidebar file previews,
desktop file windows, and standalone Chat files. It uses native textarea input
with an owned highlighting layer, line-number gutter, and monospace font.
Media keeps its existing preview. Markdown files open in View mode by default;
Edit and structured visual modes remain available through the mode controls.
Code in View mode uses the same native editor, syntax highlighting, font, and
line numbers with editing and the caret disabled. Selection, copying, scrolling,
and keyboard navigation remain available; switching back to Edit retains the
document draft and undo history.

Save explicitly with the existing Save control or Command/Ctrl+S. Tab and
Shift+Tab indent and unindent; Escape releases keyboard focus. The editor uses
horizontal scrolling and native selection, clipboard, touch, and composition
input. It intentionally has no autocomplete, semantic services, diagnostics,
folding, or minimap.

In Pro mode the editor stays transparent over the app's existing backdrop tint.
Clicking into its text does not add a focus rectangle; the caret and selection
remain visible.

## Syntax highlighting

The first-party lexical engine covers JavaScript, TypeScript, JSX, TSX, Rust,
Dart, Python, Go, Java, Kotlin, Swift, C, C++, C#, Ruby, PHP, Lua, HTML, XML,
CSS, SCSS, JSON, JSONC, YAML, TOML, Markdown, shell, SQL, Dockerfile, Makefile,
environment files, INI, and properties files. Filename/extension detection and
bounded shebang inspection select a language. Unknown text remains editable.
Gradle `.gradle` files use Groovy highlighting, including closures, multiline
and interpolated strings, and slashy strings. `.gradle.kts` remains Kotlin.
Windows `.bat` and `.cmd` files highlight commands, comments, labels, parameters
and variable expansion, including variables inside quoted Windows paths.

The engine carries multiline state and handles embedded scripts/styles,
JSX expressions, and fenced Markdown code. Class/type/function colors use
lexical patterns rather than project-wide symbol knowledge. Incomplete or
unrecognized constructs can receive approximate coloring; this is not a
compiler or language server. Coloring failure falls back to plain text.

Language families load on demand in a module worker. Document/revision fences
reject stale responses. Line checkpoints allow incremental tokenization until
lexical state converges, while the highlighted DOM covers the viewport plus
overscan. Long-line token output is bounded without truncating editable text.
Hidden editors retire their highlighting workers and restore selection and
scrolling when shown again. Editing an extensionless file's shebang updates its
language without reopening the file.

## License documents

`LICENSE`, `LICENCE`, `COPYING`, `UNLICENSE`, and common suffixed variants such
as `LICENSE.md` and `LICENSE-MIT` open in a readable, wrapping document view
without line numbers. Explorer, sidebar previews, file windows and standalone
Chat files share the view. Choose Edit/Editor to change the original text;
Preview/Read only shows that same draft, and saving remains explicit.

Recognized license text gets a summary card above the complete original file.
The initial catalog covers MIT, Apache 2.0, BSD 2-Clause, BSD 3-Clause, ISC,
Unlicense, GPLv3 and MPL 2.0, plus bare "All rights reserved" copyright notices.
Custom or modified terms keep the document view without a guessed summary.
Detection uses local SHA-256 fingerprints of full canonical texts after
normalizing whitespace, known short headings and leading copyright notices.
Names, SPDX tags and incomplete excerpts do not establish a match. Summary
descriptions and fingerprints load on demand; file text is visible immediately,
and detection failure does not prevent reading, editing or saving. No file
content is uploaded for identification. The original terms remain authoritative.

Canonical SPDX comparison texts and their pinned source revision live under
`cantrip_app/src/components/editor/licenses/` as test fixtures and are excluded
from the production client. Descriptions link to Choose a License references.
The GPLv3 document alone does not determine whether a project's grant includes
an "or later" option.

## Log files

`.log` files and numbered rotations such as `.log.1` open in View mode.
Project log views and popped-out file windows start at the bottom and follow
new output. Scrolling up pauses both following and live reads; scrolling back
to the bottom or choosing **Follow log** resumes. **Pause following** also
works for short logs that do not scroll. Hidden panels and background browser
windows stop polling and catch up when shown again.

The worker reads a bounded tail and then only new bytes through the existing
encrypted file operations, once per second while following. This also supports
logs larger than the ordinary 10 MiB text preview limit. The viewer retains up
to 10,000 recent lines or 256 Ki characters; older output remains in the file.
Rotation, truncation, and output that outruns the retained window start a fresh
tail. Incomplete UTF-8 writes wait for the next read. Read failures keep the
visible text and offer Retry. Idle reads do not replace the input, recolor the
whole file, or rerender unchanged output.

Choose Edit to explicitly load an editable full-file buffer within the existing
editing limit. Dirty drafts remain separate from the live tail and retain the
normal save/conflict behavior. Standalone Chat log files also default to
read-only Preview; their scratch-file viewer keeps its existing loading model.

Run `node scripts/qa/log-file-follow.mjs` after building shared packages for
Chromium/WebKit checks using the production app/server/worker, including large
logs, following, both pause/resume controls, visibility, rotation/truncation,
and mode changes. Screenshots and results are written
to `test-results/log-file-follow/`.

## Large text previews

Project and file-document text previews support UTF-8 files up to 10 MiB.
Files above the 2 MiB editing limit open as read-only, syntax-highlighted text.
The first request loads at most 10,000 lines or 256 KiB; scrolling near the end
loads the next page. **Load more** also works without scrolling, including files
with very long lines. The renderer paints only the visible rows and overscan,
and appending text preserves selection and scroll position. Hidden previews do
not request more pages, and there is no preview polling.

Pages travel through the existing encrypted server relay. A worker revision
fingerprint prevents combining pages from different versions of a file; use
Refresh if the file changes. Large Markdown and structured documents use the
plain text preview rather than eagerly parsing the full document. Partial text
never enters an editable draft, save, recovery, or transfer buffer. A reopened
or popped-out large preview loads a fresh snapshot from the beginning.

Run `node scripts/qa/large-text-preview.mjs` after building shared packages to
exercise the production app/server/worker in Chromium and WebKit with an exact
10 MiB file, first-page and end-of-file rendering, scroll loading, encrypted
requests, no idle/hidden page fetches, refresh, changed-file rejection, and the
upper size limit. Results and screenshots are written under
`test-results/large-text-preview/`.

## Drafts and saving

Document sessions retain text, selection, scrolling, and undo history across
ordinary tab and mode changes. Clean caches are bounded; dirty documents are
not silently evicted. Views reset their sessions when switching account/server.
Sessions distinguish workers, projects, worktrees, and paths. Standalone Chat
reads and writes pin the worker and scratch root that supplied the document.
The server rejects requests whose expected checkout or scratch binding moved.
Standalone Chat sessions also survive in-app navigation that unmounts their
preview. Reopening a dirty file restores its original scratch binding, even
when the Chat has moved; an actual read or save failure retains the draft.
Confirmed closing/discarding removes the retained draft. Account identity
changes clear these in-memory sessions, and hidden dirty Chat drafts still
participate in the page-unload warning.

Native file windows also intercept Tauri's titlebar close request. Clean windows
close immediately; dirty documents or pending saves require **Keep editing** or
**Close and discard**. A failed native close keeps the document available and
offers a retry. If an Explorer popout's account/server changes, its file authority retires and
late responses cannot rebind it. Dirty buffers remain in their original window
and scope for copying or explicit discard; they cannot save through another
account. Clean retired windows clear their cache and close.

File access uses the existing encrypted app-to-server-to-worker operations and
loaded revision checks. Supported BOM and line endings are preserved across
textarea normalization. Existing file size and encoding restrictions remain
in force; the editor never saves a truncated preview.

A failed save or external-change conflict retains the draft. Resolve the
external change before saving again, or explicitly reload from disk and
confirm discarding the draft. Reconnects and background reads cannot replace
dirty text. Each Save request captures its submitted text. Repeated requests
wait for earlier saves and use their returned revision; typing alone never
schedules another save.
A failed save remains dirty even if the user has reverted the text to its
loaded baseline: the write may have reached disk before its acknowledgement
failed. An explicit retry still uses the loaded revision, and background reads
or clean-cache eviction cannot discard that uncertain draft.

## Native file surfaces

Explorer, sidebar previews, and file popouts use the native editor exclusively.
Their mode controls offer View, Edit, and supported structured Visual modes.
File windows exchange only context, file/media reads, and revision-checked saves;
they do not create editor servers or embedded workbenches. The former editor
extension settings and dormant Monaco editor have been removed.

Project Code tabs also use the native file browser and editor. Existing IDs,
encrypted titles, tab placement, and checkout bindings remain in use; file
operations resolve the owned Code tab through the same encrypted worker API.
No embedded editor session or transport is created. Dirty editors survive
cache pressure and require save/discard decisions before closing or moving to
another checkout/window. An externally moved tab keeps its original draft for
copying, and stale checkout bindings cannot redirect a save.

The native editor contains no third-party editor or syntax engine. The server
and worker no longer create editor runtimes, workbench attachments,
profiles, extension hosts, or settings synchronization. Code tabs carry only
native tab metadata and checkout placement; an upgrade migration preserves
their encrypted labels and layouts while retiring old sessions and tunnels.
The desktop app no longer exposes workbench transport pools or editor window
leases. Native file windows use the existing file API handoff; ordinary desktop
tunnels retain their WorkerLink bridge and attachment lifecycle. The editor is
compiled with the client; builds do not fetch, build or package a separate editor
distribution.

## Development and verification

The implementation is under `cantrip_app/src/components/editor/`. Document
sessions, native input/history, viewport calculation, worker protocol,
incremental tokenization, and language definitions are separate modules.
Explorer and standalone Chat adapters own their loading/saving integration.
Native desktop file windows use the main window's existing encrypted APIs
through the existing BroadcastChannel handoff, without obtaining their own
file authority or editor server.

To add a language, extend the language IDs and the appropriate programming/data
definition family, then update filename, extension, shebang, and fence aliases
as applicable. Add lexical-state handling only when the shared scanner cannot
express the construct. Include complete and incomplete fixtures, multiline
edits, and incremental-versus-fresh-scan assertions. Keep definitions lazy and
plain text available when detection or highlighting fails.

After normal workspace setup, run:

```sh
pnpm qa:native-editor
pnpm qa:native-editor:integration
pnpm qa:native-editor:bundle
pnpm qa:native-editor:close
pnpm qa:editor-file-polish
```

The component fixture tests Chromium and WebKit at desktop and phone sizes,
including large documents and real disposable file saves/conflicts. The full
integration fixture builds the production client and launches a disposable
server and worker using the repository's configured development runtimes. It
tests normal file opening, saves, continuity, restart recovery, conflicts, and
file-window messaging. Generated evidence lives in ignored `.qa/` directories.
It does not access a user's project or make model calls.

The component runner additionally exercises deterministic composition events
with native insertion, Unicode, indentation/history, saves concurrent with
typing, touch focus, four theme combinations, forced colors, viewport resizing,
hidden-worker disposal, and a 10,025-character line. It reports small/large-file
input-to-paint, warm switching, and large-file scroll/highlight timings.
Composition events and resized viewports do not reproduce a physical IME or
software keyboard. The integration runner restarts both real server and worker
processes, then verifies explicit saves after reconnection. It also creates an
actual alternate worktree, saves there through the native file window, and
verifies that the Primary file did not change.
It also provisions a standalone Chat through the normal API, seeds a disposable
scratch file after the worker creates its root, and reads/saves that file using
the actual Chat file-window route.
The account-revocation case also proves that an independent popout retains its
draft while rejected saves leave the worker file unchanged.

The close runner uses the actual installed Tauri JavaScript SDK against an
explicit simulated native host in Chromium/WebKit desktop/phone layouts. It
checks cancellation, repeated requests, failed-close retry, pending saves,
actual disposable disk writes, and clean closing. This does not replace a
native Tauri shell run. The Tauri build validates the capability declarations;
file windows have narrowly scoped close/destroy permission, and Chat file
windows share the existing popout capabilities.

The file-polish runner exercises the actual file-window component with its
BroadcastChannel client and a disposable HTTP file owner. Chromium/WebKit
desktop and phone layouts check license cards, unknown/custom text, Preview/Edit
draft continuity and actual disk saving, Groovy/batch worker highlighting, and
the editor's computed transparency and absence of a focus border. This is a
browser fixture; it does not run a native shell or an account server.

The bundle command emits `.qa/native-editor-bundle/report.json` with production
asset sizes and module attribution. Whole shared chunks are not incremental
editor cost. Module character counts precede final chunk minification and
cannot be added to gzip sizes. Compare measurements under the same conditions;
neither fixture timings nor worker sizes represent full-client startup cost.

An October 21, 2026 macOS arm64 sample using Node 24.14.0 and headless
Chromium/WebKit measured component-fixture opening at 118–278 ms and warm file
switching at 36–60 ms across desktop/phone layouts. Time from an input event
through two animation frames was 11–19 ms for the small document and 35–44 ms for the
20,001-line document; scrolling to its final line took 39–54 ms, with coloring
arriving at 87–137 ms. These are individual fixture samples, not production
latency guarantees, and the broad repository checks were running concurrently.
The full production-client fixture records its own file-open/API timings,
which also include encrypted worker connection setup.

Production attribution after the Gradle, batch and license-view additions
recorded 28,599 rendered characters for fourteen owned client editor modules
before final chunk minification, including lazy license identification. The
worker entry was 13,243 raw / 4,788 gzip bytes; its two lazy grammar families
were 6,940 raw / 3,077 gzip bytes combined. Editor CSS was 3,084 raw / 1,090 gzip
bytes. The lazy license summary/identification chunk was 4,043 raw / 1,697 gzip
bytes. Full license comparison fixtures were absent from emitted assets. The
shared chunk containing eleven of the editor modules also contained 231 other
modules; its complete size is not the incremental editor cost. Preserve the
generated report when comparing later builds rather than inferring cost from
filenames.

The integration runner accepts `--phone` for a focused Chromium phone run and
defaults to Chromium desktop when invoked directly without `--all`. Phone
viewport/touch emulation and browser file-window tests are not evidence of a
physical device's software keyboard or the native Tauri window shell. Record
those checks separately when devices are available. Keep component timing,
full-client timing, and production bundle measurements distinct.
