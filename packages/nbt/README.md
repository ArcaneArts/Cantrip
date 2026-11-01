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
EOF, allowing a growing disk-backed decompression spool. Browser `File`/`Blob`
objects use `blobNbtSource` without a worker backend. Cantrip's optional
`FileAccess.binary` opens protected, version-bound remote ranges (up to 256 KiB)
and supports cancellation/close; every worker range releases its own file handle.

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

## Encrypted paged storage

`@cantrip/nbt/storage` provides browser-only storage for byte sources and the
future disk-backed index:

- `openEncryptedNbtCache(binding, options)` opens OPFS, then IndexedDB, then
  bounded memory after actual opening/write failures. A failed write migrates
  existing ciphertext one page at a time before switching backing stores. A
  failed migration retains the original store and reports the storage error.
- `EncryptedNbtPageCache` authenticates each 64 KiB page with AES-GCM, binding it
  to the supplied account/document/revision scope and opaque page identifier.
  Its decrypted LRU defaults to 16 MiB; reads return caller-owned copies. The
  default nonextractable key is ephemeral and never persisted. Durable drafts
  must use the account vault/recovery layer rather than this disposable cache.
- `NbtByteSpool` appends expanded bytes incrementally and exposes them to the
  codec while indexing is in progress. Reads wait for bytes, validated EOF, a
  cancellation, or an explicit failure. Finish only after the decompressor has
  validated its final checksum. A missing/authentication-failed page is an error,
  never fabricated document bytes.
- Close aborts/fences work, clears owned decrypted buffers, disposes the cipher,
  and removes the backing store. Callers must close their spool/cache when the
  document lifetime ends and release their own returned byte buffers.

Production browser-worker storage QA runs 100 MiB expanded data through a
128 KiB decrypted cache with actual OPFS and IndexedDB in Chromium and WebKit.
It also exercises private-session fallback and an injected write failure:

```sh
node scripts/qa/nbt-storage-browser.mjs
node scripts/qa/nbt-binary-transport.mjs
```

The transport harness uses the normal app/server/worker APIs in a disposable
repository. Parsing integration, paged indexes, edits, durable recovery, and
physical-phone qualification remain later milestones in the implementation
contract. No full document object or giant recovery JSON should be built from
this storage layer.
