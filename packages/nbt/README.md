# Client NBT codec

Browser-only NBT primitives for Cantrip's viewer/editor. No filesystem, Node,
server, React, or eager document-object dependency is required at runtime.
The complete integration contract is in [NBT_IMPLEMENTATION.md](../../docs/NBT_IMPLEMENTATION.md).

- `scanNbt(source, encoding, store, options)` iteratively indexes decompressed
  bytes, including an optional Bedrock level header. Tag names/string values
  remain spans and numeric arrays remain single indexed nodes. Index records
  are provisional until the scan finishes and the decompression stream reaches
  EOF successfully; do not acknowledge a partial/corrupt document as complete.
- `NbtIndexStore` accepts asynchronous paged implementations. A store belongs
  to exactly one immutable document revision. `MemoryNbtIndex` is provided for
  fixtures and small documents; the large-file app must supply encrypted paging.
- `readNbtName`, `readNbtText`, `readNbtScalar`, and `readNbtArrayPage` decode
  bounded pages. A truncated string preview is not its full editable value.
  Names/values can be invalid even when their structural spans are indexable;
  decoding reports those errors at their byte offsets.
- `encodeNbtPayload` streams a typed new/edited subtree, without an envelope or
  compression. Compound entries are ordered iterables, preserving duplicates.
  Lists require a declared type and count. Array typed buffers preserve their
  underlying bits and are emitted in bounded chunks with endian conversion.
- `encodeNbtFile` wraps a byte-backed serialized payload with the selected
  Bedrock envelope and compression. The serialized payload length is needed
  for a Bedrock header; preserve the original `levelVersion` when editing.
- `transformNbtCompression` uses native browser streams and a checked streaming
  fallback. Invalid/truncated wrappers and checksum mismatches reject the stream.
- `copyNbtBytes(originalSource)` is the unchanged-export path. It preserves
  original compressed bytes, floating-point payloads, unusual empty-list
  declarations, string encodings, and envelope metadata without normalization.

Profiles cover big-endian named/unnamed Java data, little-endian Bedrock files,
and little-varint network data. Strings are selected explicitly: Java modified
UTF-8 preserves UTF-16 code units; UTF-8 edits reject lone surrogates rather
than silently replacing them. Longs remain `bigint`; encode them as decimal
strings in any JSON-based recovery protocol.

Byte sources must represent one immutable version, return no more than the
requested length, and return an empty range only at EOF. Sources may provide
short reads. Unknown-size sources must wait for requested bytes or definitive
EOF, allowing a growing disk-backed decompression spool. Cache encryption,
source version checks, transport, session ownership, and draft recovery belong
to the subsequent integration milestones, not to the codec's format layer.

Tests include byte-level golden inputs, comparison with NBTify (test-only),
fragmented reads, all tag types, integer limits, raw NaN/negative-zero payloads,
duplicate names, deep nesting, malformed counts/varints, cancellation, and native
and fallback compression. Browser-worker QA needs the repository's Playwright
Chromium/WebKit installations and runs with:

```sh
pnpm --filter @cantrip/nbt build
pnpm --filter @cantrip/nbt test
node scripts/qa/nbt-codec-browser.mjs
```
