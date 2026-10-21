# Cantrip code editor

Text files open in Cantrip's own editor in Explorer, sidebar file previews,
desktop file windows, and standalone Chat files. It uses native textarea input
with an owned highlighting layer, line-number gutter, and monospace font.
Media keeps its existing preview. Markdown preview and structured visual modes
remain available through the existing mode controls.

Save explicitly with the existing Save control or Command/Ctrl+S. Tab and
Shift+Tab indent and unindent; Escape releases keyboard focus. The editor uses
horizontal scrolling and native selection, clipboard, touch, and composition
input. It intentionally has no autocomplete, semantic services, diagnostics,
folding, or minimap.

## Syntax highlighting

The first-party lexical engine covers JavaScript, TypeScript, JSX, TSX, Rust,
Dart, Python, Go, Java, Kotlin, Swift, C, C++, C#, Ruby, PHP, Lua, HTML, XML,
CSS, SCSS, JSON, JSONC, YAML, TOML, Markdown, shell, SQL, Dockerfile, Makefile,
environment files, INI, and properties files. Filename/extension detection and
bounded shebang inspection select a language. Unknown text remains editable.

The engine carries multiline state and handles embedded scripts/styles,
JSX expressions, and fenced Markdown code. Class/type/function colors use
lexical patterns rather than project-wide symbol knowledge. Incomplete or
unrecognized constructs can receive approximate coloring; this is not a
compiler or language server. Coloring failure falls back to plain text.

Language families load on demand in a module worker. Document/revision fences
reject stale responses. Line checkpoints allow incremental tokenization until
lexical state converges, while the highlighted DOM covers the viewport plus
overscan. Long-line token output is bounded without truncating editable text.

## Drafts and saving

Document sessions retain text, selection, scrolling, and undo history across
ordinary tab and mode changes. Clean caches are bounded; dirty documents are
not silently evicted. Account/server changes clear their cached sessions.
Sessions distinguish workers, projects, worktrees, and paths. Standalone Chat
reads and writes pin the worker and scratch root that supplied the document.
The server rejects requests whose expected checkout or scratch binding moved.

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

## VS Code remains available

In Explorer, open the file mode menu and choose **Open in VS Code**, or use
the **VS Code** button in a desktop file window. A dirty
file requires explicit confirmation to save first; cancellation or a failed
save keeps the native draft. Explicit Code tabs and the existing workbench,
runtime, settings, and packaging remain supported.

Ordinary file opening does not attach an inline workbench or load Monaco.
The new editor contains no third-party editor or syntax engine. Existing
preview renderers and explicit VS Code functionality retain their dependencies.

## Development and verification

The implementation is under `cantrip_app/src/components/editor/`. Document
sessions, native input/history, viewport calculation, worker protocol,
incremental tokenization, and language definitions are separate modules.
Explorer and standalone Chat adapters own their loading/saving integration.
Native desktop file windows use the main window's existing encrypted APIs
through the existing BroadcastChannel handoff, without obtaining their own
file authority or editor server.

After normal workspace setup, run:

```sh
pnpm qa:native-editor
pnpm qa:native-editor:integration
```

The component fixture tests Chromium and WebKit at desktop and phone sizes,
including large documents and real disposable file saves/conflicts. The full
integration fixture builds the production client and launches a disposable
server and worker using the repository's configured development runtimes. It
tests normal file opening, saves, continuity, restart recovery, conflicts, and
file-window messaging. Generated evidence lives in ignored `.qa/` directories.
It does not access a user's project or make model calls.

The integration runner accepts `--phone` for a focused Chromium phone run and
defaults to Chromium desktop when invoked directly without `--all`. Phone
viewport/touch emulation and browser file-window tests are not evidence of a
physical device's software keyboard or the native Tauri window shell. Record
those checks separately when devices are available. Keep component timing,
full-client timing, and production bundle measurements distinct.
