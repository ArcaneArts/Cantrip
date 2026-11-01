# NBT implementation contract

This is the complete accepted NBT implementation scope. It remains the goal
until every completion condition below has direct evidence. The codec package
is a foundation; its presence does not mean the app viewer/editor has shipped.

| Milestone                              | Current state        | Required evidence                                                                           |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| 1. Lossless client codec               | Implemented          | Codec tests, independent fixtures, production browser-worker QA                             |
| 2. Binary access and encrypted storage | Implemented          | Protected range reads, pinned revisions, encrypted OPFS/IndexedDB spill and cancellation    |
| 3. Background parser integration       | Implemented          | Dedicated document worker, progressive disk-backed indexing, bounded working set            |
| 4. Tree/table viewer and global search | Baseline implemented | Actual app interactions, unloaded-subtree search, paged grids and responsive navigation     |
| 5. Typed editing and streamed saves    | Implemented          | All edit operations, undo/redo, atomic version-checked saves and interrupted-write receipts |
| 6. Recovery, ownership, and phones     | Pending              | Encrypted recoverable drafts, safe close/pop-out/return, touch editing and phone saves      |
| 7. Qualification                       | Pending              | Full malformed/concurrency/storage matrix, measured desktop/browser/mobile performance      |

Milestone 1 validation commands:

```sh
pnpm --filter @cantrip/nbt build
pnpm --filter @cantrip/nbt test
node scripts/qa/nbt-codec-browser.mjs
```

The browser QA runs the built client codec in a dedicated worker in Chromium
and WebKit, including native/fallback compression and a synthetic one-GiB
array accessed through bounded byte ranges. This proves codec execution and
range behavior; it does not prove physical-phone or full-app qualification.
`MemoryNbtIndex` is an explicit small-document/fixture implementation. It must
not be selected for the large-file app path when that integration is added.

Milestone 2 validation commands:

```sh
pnpm --filter @cantrip/nbt build
pnpm --filter @cantrip/nbt exec vitest run --maxWorkers=1
pnpm --filter @cantrip/protocol exec vitest run src test --exclude 'dist/**' --maxWorkers=4
pnpm --filter @cantrip/worker exec vitest run test/explorer-binary.test.ts src/commands/file-document.test.ts --maxWorkers=2
pnpm --filter @cantrip/app exec vitest run src/lib/binary-file-source.test.ts src/lib/file-access.test.ts src/lib/api/file-documents.test.ts --maxWorkers=2
node scripts/qa/nbt-storage-browser.mjs
node scripts/qa/nbt-binary-transport.mjs
```

Storage QA streams 104,857,616 expanded bytes through a 131,072-byte decrypted
LRU in a dedicated production-built worker. It uses actual OPFS and IndexedDB
in Chromium and WebKit, confirms early array descriptors and tail reads, and
migrates encrypted pages after an injected OPFS write failure. An additional
private-session run attempts OPFS normally and exercises IndexedDB fallback
when WebKit rejects OPFS opening. These tests use a two-node large-array
fixture, not a million-node index or a physical phone.

The protected transport QA uses a real app, server, and worker with a sparse
one-GiB file in its disposable repository. Ranges stay within 256 KiB without
raising protected message limits or using the text-preview size cap. Reads
pin the worker's file version, fail on source changes, cancel in-flight reads,
and close on account changes. No long-lived worker file handles are retained. This is revision
fencing rather than a physical immutable filesystem snapshot; a changed source
requires reopening, and cached bytes belong to their original revision.

The default storage key is nonextractable and ephemeral. Durable encrypted
recovery, crash-orphan cleanup, document ownership, and the actual viewer/editor
remain milestones 4–7. Disposable cache removal must
never be used as draft persistence.

Milestone 3 validation commands:

```sh
pnpm --filter @cantrip/nbt build
pnpm --filter @cantrip/nbt exec vitest run --maxWorkers=1
pnpm --filter @cantrip/app exec vitest run src/lib/nbt/document.test.ts src/components/explorer/explorer-native-session.test.tsx --maxWorkers=2
pnpm --filter @cantrip/app build
node scripts/qa/nbt-codec-browser.mjs
node scripts/qa/nbt-document-browser.mjs
```

The production app worker opens browser Files/Blobs directly or brokers bounded
protected binary source reads through its client. Parsing, decompression,
indexing, display decoding and baseline serialization stay in the worker.
`PagedNbtIndex` uses fixed descriptor pages and 256-child sparse checkpoints,
with no whole-document map. Stable preorder IDs also fix the byte-offset
identity collision between compound list items and their first properties.

Document-worker QA covers a 104,857,616-byte expanded array and 1,050,002 tags
in Chromium/WebKit, using a 128 KiB byte cache and at most 16 decoded index
pages. It checks early rows, pause/cancellation, precise Longs at the end,
paging without source rereads, idle behavior, streamed original export, and
baseline recompression/reopen. Main-thread frame sampling excludes synthetic
fixture generation. Exact timings are workload observations, not full app or
physical-phone qualification. The fixture uses a large numeric array and many
small properties; the 1 GiB app stress case remains milestone 7.

The dedicated worker and app factory are available to the viewer integration;
the visible tree/table/search UI is milestone 4. Typed edit serialization and
atomic worker writes are milestone 5; shared ownership, encrypted recoverable
journals, locking and phones remain milestone 6. Disposable index cache flush
is not a replacement for durable draft recovery.

Milestone 4 validation commands:

```sh
pnpm --filter @cantrip/nbt build
pnpm --filter @cantrip/nbt exec vitest run --maxWorkers=1
pnpm --filter @cantrip/app exec vitest run src/components/nbt/use-client.test.tsx src/components/files/file-viewers.test.ts src/lib/nbt/document.test.ts src/lib/binary-file-source.test.ts src/lib/file-access.test.ts src/lib/api/file-documents.test.ts --maxWorkers=2
pnpm --filter @cantrip/app build
node scripts/qa/nbt-viewer-browser.mjs
node scripts/qa/nbt-project-viewer.mjs
```

The app registers an NBT viewer and an Open As → NBT override. Its dedicated
worker provides rank-selected virtual tree pages, sparse expansion state,
ancestor navigation, typed compound-list tables, and decimal/hex numeric-array
grids. Large scroll extents are scaled rather than relying on browser element
heights large enough for hundreds of millions of rows. Table columns come from
a user-selected available item and have their own pagination; reverse display
order does not mutate source bytes. Every field remains accessible through the
tree, table reference-item selector, and whole-document search.

Literal search covers full names, values, types, and escaped JSON Pointer style
paths, including unloaded/collapsed branches and numeric array elements. Long
matching never converts integers through Number. Results stream from a
cancellable worker job into separate encrypted result pages; contiguous array
matches use runs rather than allocating one object per element. Exact totals
require the validated end of the document, including compressed checksums.
The compact find chip supports Enter/Shift+Enter, case sensitivity, exact
numbers, and selected-subtree scope. Encoding and compression remain explicit
controls for ambiguous files and malformed-data diagnostics.

Browser interaction QA in Chromium and WebKit opens a 100 MiB expanded gzip
array with unopened tail properties, finds those full values, reveals ancestors,
checks exact Longs, reaches the last of 104,857,600 numeric elements with only
viewport cells mounted, and exercises keyboard navigation, typed tables,
column paging, format selection, diagnostics, and idle/inactive behavior.
A separate real app/server/worker fixture opens a protected 12 MiB expanded file,
finds its tail value, forces NBT for an unknown extension, and reads the final
array element. The ordinary local-file input and 390px layout are browser tests,
not physical iOS/Android qualification.

Milestone 4 establishes baseline browsing. Milestone 5 extends the same
`NbtReadModel` with typed edits and logical identities; recovery, shared ownership,
physical-phone testing, and the complete qualification matrix remain milestones
6–7.

Milestone 5 validation commands:

```sh
pnpm --filter @cantrip/nbt build
pnpm --filter @cantrip/nbt test
pnpm --filter @cantrip/protocol exec vitest run src test --exclude 'dist/**' --maxWorkers=2
pnpm --filter @cantrip/worker exec vitest run test/binary-file-writes.test.ts src/commands/file-document.test.ts
pnpm --filter @cantrip/server exec vitest run test/file-documents.test.ts
pnpm --filter @cantrip/app exec vitest run src/lib/nbt/save.test.ts src/lib/nbt/session-registry.test.ts src/components/explorer/explorer-lifecycle.test.ts
pnpm --filter @cantrip/app build
node scripts/qa/nbt-edit-project.mjs
```

The project fixture requires the Cantrip CLI and CUA runtimes, as the other
protected project fixtures do. Existing builds can be selected with
`CANTRIP_CLI_BIN` and `CANTRIP_CUA_BIN`. `CANTRIP_NBT_QA_ENGINE` selects one
browser when diagnosing a failure; the default runs Chromium and WebKit.

`NbtDocumentSession` owns a versioned operation journal, persistent edit roots,
undo/redo, and frozen save snapshots in the dedicated document worker. Values,
renames, insertion, deletion, duplication, explicit type replacement, numeric
array splices, and byte-backed string splices are transactions. Exact Longs
remain decimal strings across RPC and BigInt in the codec. Lists enforce their
element type; new duplicate compound names are rejected while existing unusual
entries and raw floating-point payloads remain intact. Duplicating an unopened
subtree retains source ranges instead of materializing its descendants.

The tree/table/grid and full-document search use the edited logical model.
String editing loads character-aligned 4 KiB pages. Array edits and pastes use
bounded batches of up to 4,096 values. These transaction bounds do not impose a
whole-document size limit. A small edit changes persistent overlay roots and
its affected descriptors, rather than cloning or serializing the entire tree.
Journal records and long search identities are split across encrypted 64 KiB
cache pages. The journal manifest is the transaction commit point.

Saves stream the frozen baseline plus edits through the original encoding and
compression into protected 256 KiB write chunks. Worker staging chunks and
write-ahead receipts are encrypted with worker component material. The worker
checks the output size and SHA-256, syncs a publication temporary beside the
target, revalidates the expected version, and atomically publishes it. Durable
prepared/committed receipts reconcile worker restarts and lost responses.
Concurrent app saves to the same target are serialized; external changes are
checked immediately before publication. This is revision checking plus atomic
replacement, not a filesystem compare-and-swap against arbitrary external
writers. The publication temporary necessarily contains the requested output
bytes; resumable staging and receipt data remain encrypted.

The UI reports dirty/save state and retains interrupted snapshots for Retry.
Edits made during a save remain dirty afterward. Conflicts retain the draft and
offer Retry, Reload, and Save As. Reload validates the actual replacement before
retiring the current draft, so an unreadable replacement does not destroy it.
Save As creates a new immutable file document, opens it, and retains the original
tab's draft. A copy receipt never marks the original path saved.

The production protected app/server/worker QA in Chromium and WebKit edits a
100 MiB expanded gzip document: string changes, renaming, exact Long insertion,
duplicate/delete/undo/redo, the final array element, and unsaved search. It
verifies original bytes remain intact before publication, drops the actual
commit acknowledgement, reconciles the receipt, and reopens the result with
both the app and an independent parser. It also checks an external-write
conflict, an invalid replacement that fails reload without losing the draft,
and Save As into a new document while preserving the external original.

Live runtime leases retain detached dirty workers and pause inactive parsing.
Custom-viewer lifecycle state participates in existing save, preview replacement,
dirty-close, and close-cancellation handling, including edits awaiting their
worker acknowledgement. This is **not durable draft recovery**: cache keys are
still ephemeral, journals are not yet reopened after a client restart, and
runtime ownership is scoped to a view. Until milestone 6 adds shared durable
ownership, dirty NBT drafts must be saved before moving a window or quitting.
Encrypted reload recovery, cross-window transfer, local OS export, orphan
cleanup, and actual phone qualification remain mandatory unfinished work.

## Accepted plan

I’d build this as a **client-side NBT document viewer/editor**, with the same core running in desktop, browsers, and phones. The worker would provide file access and safe writes; the client would understand and display NBT.

The important design decision is to keep large documents **backed by bytes and a paged index**, rather than turning the entire file into a JavaScript object.

Cantrip already has useful foundations: [structured visuals](../cantrip_app/src/components/explorer/structured-file-visual.tsx), [file access](../cantrip_app/src/lib/file-access.ts), and [document recovery](../cantrip_app/src/lib/document-recovery-session.ts). We should reuse their presentation and lifecycle patterns. The current structured-data model, which materializes values and limits visual node counts, needs a separate large-file implementation for NBT.

**The intended experience**

Opening an NBT file should show a tree with editable properties:

| Name / index  | Type            | Value               |
| ------------- | --------------- | ------------------- |
| ▾ Data        | Compound        | 24 entries          |
| ↳ LevelName   | String          | Survival World      |
| ↳ Time        | Long            | 9223372036854775807 |
| ↳ ▸ Player    | Compound        | 38 entries          |
| ↳ ▸ Inventory | List · Compound | 36 items            |
| ↳ ▸ Heightmap | Long Array      | 256 elements        |

Compounds expand into named properties. Lists expand into indexed items. Large arrays open as virtualized grids. Lists of similar compounds can switch to a table, with fields as columns.

The panel should have View/Edit modes, a compact find chip, breadcrumbs, save status, and undo/redo. On phones, selecting a value opens a compact editing sheet with its name, type, and value.

1. **Define format support and a lossless document model**

   Support these profiles explicitly:

   | Profile                          | Planned support                                                                            |
   | -------------------------------- | ------------------------------------------------------------------------------------------ |
   | Java NBT                         | Big-endian, named roots, raw/gzip/zlib                                                     |
   | Bedrock file NBT                 | Little-endian, including the `level.dat` envelope                                          |
   | Network-oriented NBT             | Explicit profiles for unnamed roots and little-varint encoding                             |
   | Region files and world databases | Separate container adapters; these contain NBT but require additional file-format handling |

   Existing libraries demonstrate browser support and these encoding variants. [NBTify](https://github.com/Offroaders123/NBTify) is browser-native; [Prismarine-NBT](https://github.com/PrismarineJS/prismarine-nbt) supports big-endian, little-endian, and little-varint formats.

   Preserve every standard value type: Byte, Short, Int, Long, Float, Double, String, List, Compound, Byte Array, Int Array, and Long Array. `End` remains a structural marker, rather than an option for adding a property.

   The model must retain:

   - Exact tag types, root naming, list element types, and encoding profile.
   - Compound entry order, including duplicate names found in existing files.
   - Original byte ranges for unchanged values.
   - Exact signed 64-bit integers using `BigInt`, with decimal-string encoding where persistence requires JSON.
   - Floating-point distinctions such as negative zero and unchanged NaN bit patterns.

   Use stable node identifiers. A displayed path alone cannot identify entries reliably when names repeat or list items move.

   **Completion condition:** fixtures covering all supported tag types and profiles can be read and written without losing information. An untouched file can be exported byte-for-byte unchanged.

2. **Add binary file access and browser storage**

   Extend Cantrip’s `FileAccess` abstraction with a generic binary source. Its current media reader already transfers chunks, but assembles them into a complete Blob and restricts supported media types.

   The new source should support:

   - Opening a version-bound document.
   - Reading bounded byte ranges.
   - Cancelling reads and releasing snapshots.
   - Reporting file changes without mixing different revisions.

   Both remote project files and local browser `File` objects should implement this interface. A phone can therefore inspect a selected local file without an NBT-capable backend.

   Keep remote access on the existing protected app → server → worker path. Start with the existing approximately 256 KiB chunk size; avoid increasing message limits to accommodate whole files.

   For larger documents, use an encrypted, paged cache in OPFS, with an IndexedDB fallback. OPFS supports file access inside dedicated Web Workers, making it suitable for this workload. Browser storage can still fail or be evicted, so failures must be handled during actual reads and writes, with bounded memory fallback where possible. [OPFS worker access](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle), [storage behavior](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

   Persisted bytes, indexes, and edit journals must follow Cantrip’s existing encryption rules. Tag names and values should not enter layout metadata or logs.

   **Completion condition:** a document larger than the memory cache can be consumed without buffering the entire file in JavaScript memory.

3. **Build the background parser and paged index**

   Run parsing, decompression, indexing, and serialization in a dedicated Web Worker. React should receive small pages of display records.

   The parser should:

   - Process input incrementally using an explicit stack.
   - Index tag boundaries, parent relationships, types, and child locations.
   - Decode names and values when needed.
   - Use direct offset calculations for fixed-width array elements.
   - Create sparse checkpoints for large variable-length lists.
   - Spill index pages to encrypted storage as necessary.

   Native compression streams can handle gzip and zlib processing in workers; include a streaming fallback for supported environments that lack the required API. [Compression Streams specification](https://compression.spec.whatwg.org/).

   Compressed NBT has an unavoidable constraint: reaching a later tag generally requires decompressing the preceding data. The viewer should expose the first available rows while indexing continues. It should distinguish “available so far” from “complete.”

   NBTify’s current reader constructs arrays and objects eagerly. It is useful for comparison fixtures, but that representation should not become our large-document model. Use independent byte fixtures and library comparisons to verify our indexed codec. [NBTify reader](https://github.com/Offroaders123/NBTify/blob/main/src/read.ts).

   **Completion condition:** scrolling and expanding already-indexed content do not restart parsing, decompress the file again, or allocate the complete tree.

4. **Implement the virtualized tree, tables, and search**

   Reuse the appearance of Cantrip’s structured viewers with a new paged data provider.

   Browsing should include:

   - Expand/collapse, breadcrumbs, and keyboard tree navigation.
   - Paged children for enormous compounds and lists.
   - Virtualized array grids with decimal and hexadecimal display where appropriate.
   - Table mode for lists of compounds, retaining each cell’s actual type.
   - Loading and malformed-data diagnostics attached to the relevant location.
   - “Open as NBT” for ambiguous extensions, plus an explicit format selector when detection is inconclusive.

   Table columns should come from available pages or a background schema scan. Opening a table must not require scanning every row first. Sorting the display must not silently reorder the saved file.

   Search should cover the **whole logical document**, including collapsed and unloaded branches:

   - Keys, values, types, and paths.
   - Whole-document and selected-subtree scopes.
   - Case-sensitive or insensitive literal matching.
   - Exact numeric matching without converting Long values to floating point.
   - Enter/Shift+Enter navigation, following Cantrip’s editor-find conventions.

   Results should stream in. Show “213 found · searching…” until the scan finishes; only then display an exact total. Selecting a result reveals its ancestors and scrolls directly to it.

   Keep result pages bounded, cancel stale queries, and include unsaved edits in searches. Start with literal search; add regex later only with bounded execution.

   **Completion condition:** a search finds a value near the end of a large compressed file even when its branch has never been expanded.

5. **Add typed editing and streamed saves**

   Introduce an `NbtDocumentSession` alongside the text document session. It should own the baseline version, edit journal, undo history, and save state.

   Editing should support:

   | Operation                | Behavior                                                     |
   | ------------------------ | ------------------------------------------------------------ |
   | Change value             | Validate against its existing tag type                       |
   | Add property             | Choose a standard tag type and enter its value               |
   | Rename property          | Preserve the node’s identity and value                       |
   | Insert/remove list item  | Enforce the list’s declared element type                     |
   | Edit arrays              | Change elements, insert/remove ranges, paste bounded batches |
   | Duplicate/delete subtree | Apply as an undoable transaction                             |
   | Change type              | Explicit conversion, with validation of affected values      |

   Preserve unusual existing entries rather than silently normalizing them. New duplicate compound names should be rejected by default. Byte-backed boolean controls can be offered as a display convenience while retaining the Byte type.

   Represent edits as operations over the original document. Changing one number should update that row and its affected summaries, without cloning the full tree or serializing the whole file after each keystroke.

   Saving should stream the baseline plus edits through the serializer and original compression profile. Compressed files normally require a complete new output stream, but memory use can remain bounded.

   Extend the worker’s binary write path with staged uploads:

   1. Begin an upload against the expected file version.
   2. Transfer ordered chunks into a temporary file.
   3. Verify the resulting size and checksum.
   4. Revalidate the target version and replace the file atomically.
   5. Return a durable receipt so interrupted requests can be reconciled.

   Version conflicts should retain the draft and offer reload, Save As, or reviewed reapplication of edits. A failed upload must leave the original file intact.

   **Completion condition:** a small edit to a large gzip document saves correctly, preserves unrelated data, and survives connection loss without an ambiguous dirty state.

6. **Integrate recovery, tabs, pop-outs, and phones**

   NBT documents should participate in the existing file-document lifecycle:

   - One logical editing session per document, shared by its views.
   - Dirty-close handling, encrypted recovery, and undo/redo.
   - Pop-out and return with ownership transferred safely.
   - Account changes and locking that release decrypted working state.
   - Paused indexing and rendering for inactive views; in-flight saves still settle safely.

   Recovery should store a versioned edit journal and necessary recoverable data. It must not create giant JSON snapshots of the parsed tree. Evicting a disposable cache must never discard the only copy of an unsaved edit.

   Phone support belongs in the architecture from the beginning:

   - The same client codec and document model.
   - Touch-accessible equivalents for context-menu actions.
   - A tree/table layout that fits narrow panels.
   - A compact value-editing sheet.
   - No requirement for desktop filesystem picker APIs.
   - Smaller memory caches and cancellation of unnecessary background work.

   Worker-backed project files can use streamed saves from every client. Local-file export should use available browser/OS capabilities and report actual storage or export failures clearly.

   **Completion condition:** a phone can open, search, edit, recover, and save a worker-backed NBT document using the same semantics as desktop.

7. **Qualify correctness and large-file performance**

   Measure **expanded bytes and tag counts**, alongside compressed file size.

   Build a fixture matrix covering:

   - Small reference files through 10 MiB, 100 MiB, and 1 GiB expanded stress cases.
   - Millions of small properties and very large numeric arrays.
   - Deep nesting and awkward chunk boundaries.
   - All integer boundaries, Unicode names, unusual empty lists, and floating-point edge cases.
   - Truncated files, invalid lengths, corrupt compressed streams, and unsupported profiles.
   - Source changes during reads, storage exhaustion, interrupted saves, and recovery after reload.
   - Structural edits followed by reopen and independent-parser verification.

   Initial performance targets should be treated as targets to measure:

   | Interaction                 | Target                                             |
   | --------------------------- | -------------------------------------------------- |
   | Expand an indexed branch    | First page within roughly 100 ms                   |
   | Find input and cancellation | Responsive within roughly 100 ms                   |
   | Scrolling                   | Work proportional to visible rows                  |
   | Memory                      | Bounded caches; no whole-document object expansion |
   | Idle or hidden panel        | No continuous parsing, polling, or repainting      |

   Test on desktop Chromium and WebKit, plus real iOS and Android devices. Use 100 MiB expanded documents as an initial phone qualification target and 1 GiB as a desktop stress target. These are benchmark workloads, not arbitrary file-size rejection rules.

I would deliver these as sequential implementation milestones, each through its own PR/worktree and auto-merge. The first release should include the complete browse → search → edit → save → reopen flow for standalone NBT; region-file and world-database adapters can then reuse that foundation.
