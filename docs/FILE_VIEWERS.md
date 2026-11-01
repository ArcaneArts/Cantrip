# File viewers

`cantrip_app/src/components/files/file-viewers.ts` is the registry used by file
format detection and the sidebar's **Open As** menu. Each definition supplies a
stable ID, label, icon, filename matcher, default mode, and reader/renderer
configuration. Ordinary opens use the first matching entry; the Text fallback
belongs last. Explicit choices use the entry ID regardless of the filename or
the sidebar's `viewable` hint. That filename hint no longer prevents a regular
file from opening; the selected reader reports invalid content during the actual
read. **Automatic** clears the override.

The optional `WorkspaceTab.fileViewer` value belongs to a view, not its immutable
file document. The normal open command updates an existing owner's override only
when the caller supplies it; navigation otherwise preserves it. Both server
reducers apply this rule. The field travels with detached/returned tabs, while
protected editor transfer/recovery snapshots carry it during destination staging.
No file is renamed or converted by Open As. Existing text sessions keep unsaved
edits while changing renderers.

For structured text, set `structuredFormat` and `syntaxExtension`. `defaultMode`
preserves ordinary opening behavior; `openMode` can choose Visual for an explicit
Open As action. Media definitions select a protected chunk reader that accepts an
explicit media type, allowing unfamiliar extensions without filename admission
checks. The browser decoder handles invalid content.

For a new binary/custom viewer (including the parallel NBT implementation), add
one registry definition before Text with its matcher and `Component`. Custom
components receive the actual path, protected `FileAccess`, document and
project/worktree/worker identity, appearance, active state, refresh revision, and destination `onReady`/`onError` callbacks.
They own their protected format-specific reads; the host skips its text read.
`FileAccess.binary()` provides the version-bound range source introduced by the
NBT binary-access milestone; custom parsers can consume it without media MIME
or filename assumptions.
Respect `active` when polling and report readiness only after content loads.
This component hook is a view integration point; new binary editing operations
and their save/recovery lifecycle still belong to their format implementation.
Unknown viewer IDs remain readable by the workspace schema and show an
unavailable-viewer message, with Automatic available to recover the view.
