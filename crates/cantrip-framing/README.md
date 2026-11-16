# cantrip-framing

The existing binary codecs used by both server forwarding paths and worker
transports, extracted without changing their wire formats:

- `worker_link`: CWLK envelopes, CTRL remote-surface chunks, and contiguous chunk
  assembly with the caller's existing incomplete-frame replacement policy.
- `tunnel`: CTTN data-plane frames, plaintext/protected payload limits, and credit
  constants. Protected bytes remain opaque; the codec performs no encryption.
- `remote_surface`: CTRS headers and payloads.

Creation validates and serializes headers using `cantrip-protocol`. Decoding
retains the supplied immutable `Arc<[u8]>`, including the original header bytes.
Clones share that storage. Forward `Frame::bytes()` instead of rebuilding a frame
from its normalized header when exact forwarding matters.

Error strings, UTF-8 replacement/BOM handling, size limits, payload requirements,
and chunk ordering retain the existing implementations. WorkerLink error types
live in `cantrip-protocol::worker_link`, allowing server adapters to retain their
existing classifications without creating a dependency back into the server.

This crate contains no transport connection, backpressure queue, authorization,
resource lookup, session enrollment, or routing. A future worker supplies those
runtime services. The server re-exports the codecs at its existing frame paths.

Focused tests compare bytes, errors, and chunk assembly with the maintained
TypeScript codec implementations. The remote-surface boundary test hashes large
payloads so its fixture output stays small.
