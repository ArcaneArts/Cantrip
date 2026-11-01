# NBT implementation contract

This is the complete accepted NBT implementation scope. It remains the goal
until every completion condition below has direct evidence. The codec package
is a foundation; its presence does not mean the app viewer/editor has shipped.

| Milestone                              | Current state | Required evidence                                                                           |
| -------------------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| 1. Lossless client codec               | Implemented   | Codec tests, independent fixtures, production browser-worker QA                             |
| 2. Binary access and encrypted storage | Pending       | Protected range reads, immutable versions, encrypted OPFS/IndexedDB spill and cancellation  |
| 3. Background parser integration       | Pending       | Dedicated document worker, progressive disk-backed indexing, bounded working set            |
| 4. Tree/table viewer and global search | Pending       | Actual app interactions, unloaded-subtree search, paged grids and responsive navigation     |
| 5. Typed editing and streamed saves    | Pending       | All edit operations, undo/redo, atomic version-checked saves and interrupted-write receipts |
| 6. Recovery, ownership, and phones     | Pending       | Encrypted recoverable drafts, safe close/pop-out/return, touch editing and phone saves      |
| 7. Qualification                       | Pending       | Full malformed/concurrency/storage matrix, measured desktop/browser/mobile performance      |

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
