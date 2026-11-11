# Encrypted Chat import through the worker

The Chat import comparison uses the existing WorkerConnection and the worker's
message, attachment metadata, and relay chunk codecs. The source fixture
provides synthetic history and file bytes. The worker protects the canonical
messages with the account's Chat key and authenticates attachment metadata and
chunks with a separate key. The destination opens both relay chunks and checks
the digest of the complete 300,001-byte fixture before acknowledging it.

The 103-message import verifies production batches of 100 and three. The
comparison opens each returned message with its owner and message identity,
and rejects use under a different owner or message. It checks the exact
ciphertext carried through persistence and worker hydration. Public history
exposes the protected envelope and the database retains a null plaintext
column.

The attachment import saves one ready replica and two unavailable placeholders.
A separate case changes a chunk's ciphertext while preserving its transport
fields. The destination rejects it during authentication. The server deletes
the partial upload and leaves the Chat catalog unchanged. The existing invalid
sequence, early EOF, missing EOF, reply truncation, and retry cases also run.

The suite reopens the imported Chat through public HTTP after stopping and
restarting each server. Message ciphertext, attachment metadata, and replica
rows match the original bytes and decrypt with the same endpoint keys. An
account other than the owner receives 404. The anonymous profile also retains
the existing process-kill tests during history reading and native hydration,
and waits for an actual import lease renewal while both import slots are held.

All nine local macOS arm64 storage and authentication combinations pass.
They cover 330 paired scenarios, 621 paired HTTP observations, 18 retained
server restarts, 12 process-kill reopens, and six real lease-renewal peers.
The worker produced and verified 2,454 encrypted message replies and 594
metadata envelopes, and opened 198 relay chunks. All 18 modified relay
ciphertexts were rejected. A separate verifier opens retained messages,
attachment metadata, and relayed bytes directly from the captured reports.
It also repeats the negative owner and message identity checks.

The Rust import contract test, 108 crypto tests, 37 focused worker tests, and
12 reference import tests pass. The reference suite has one existing
conditional skip. The scoped command ledger now covers 289 of 323 identities.
See the [acceptance record](security/rust-server-encrypted-chat-import-acceptance.json).

The source reads, attachment backing store, and Codex hydration results are
controlled fixture boundaries. Existing desktop import, physical attachment
storage, and final shipping acceptance remain open.

```sh
node --import tsx scripts/server-rust/chat-import-http-compatibility.mjs \
  --database pglite --leases --lifecycle --discovery \
  --report /absolute/path/to/encrypted-chat-import.json
```

Build the protocol, crypto, logging, version, and Node reference packages.
Supply the Rust HTTP fixture and database assets as in the [Chat import
qualification](RUST_SERVER_CHAT_IMPORTS.md). Repeat with `bundled-postgres`
and `postgres`.
