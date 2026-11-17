# cantrip-crypto

Native endpoint cryptography used by the Rust worker. This is new worker-side
implementation, independent of the server application, database and networking.
Server-side opaque envelope validation remains in `cantrip-protocol`.

Implemented from `packages/crypto`:

- Canonical associated data using existing UTF-16/JSON wire behavior and the
  generated protocol schemas; strict canonical unpadded base64url.
- AES-256-GCM payload encryption/authentication and canonical envelope strings.
- HPKE RFC 9180 base mode: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256,
  AES-256-GCM, with the existing Cantrip key-wrap info/context.
- Raw P-256 private/public import/export, keypair integrity and worker component
  key wrappers.
- Component/field/lookup HKDF-SHA256 derivation and blind HMAC-SHA256 tags.
- Protected secrets, endpoint payloads, private display labels and attachment
  metadata/chunks, including existing AAD bindings and encoded byte limits.
- Repository-operation payloads, including server/project/worktree/operation and
  direction bindings and the existing 16-MiB plaintext limit.
- JSON surface streams, binary remote-surface streams and tunnel data frames,
  including their distinct route/context bindings, limits and error boundaries.
- Private surface records for terminals, Explorer, file documents, browsers,
  desktop state and desktop inventory: existing resource/table/field bindings,
  persistent/ephemeral contexts, classifications and four-MiB encoded limit.

HPKE uses `hpke` 0.14.1, including its KEM zeroization fixes, with only the
alloc/AES/NIST-curve/system-random features. The suite remains P-256; the upstream
NIST feature also compiles other curve implementations. AES-GCM 0.11.1 enables
key-schedule/GHASH zeroization. HKDF/HMAC/SHA use RustCrypto implementations.
These dependencies support the workspace Rust 1.93 compiler. No crypto algorithm
is implemented here. Production key generation and nonces use system entropy;
there is no deterministic randomness switch.

`HpkeKeyPair` omits Debug and holds the library's zeroizing private-key type.
Returned private/key/plaintext buffers use `Zeroizing`; callers still must keep
secret buffers out of logs and avoid retaining unprotected copies. Decryption
normalizes validation/authentication failures to the existing generic message
and exposes a downcastable `DecryptionError` for the worker's error handling.
Validation errors for public configuration/envelopes use the shared contracts.

Tests retain small synthetic TypeScript-produced ciphertext vectors, compare
canonical bytes, and check recipient/context/tamper failures. The worker's
`crypto-fixture` and differential script exercise the unchanged TypeScript
implementation in both directions. Never give those development fixtures a real
profile or secret.

The content module validates decrypted UTF-8/JSON and the actual plaintext
schemas, preserving BOM handling and UTF-16 strings. Labels authenticate their
inner and outer classification; attachment chunks authenticate their declared
size, sequence and EOF. Chunk crypto is stateless: it does not authorize a
transfer or enforce arrival order, replay windows or resource lifetimes.

Authenticated grant refresh and its HTTP/task ownership live in
`cantrip_worker::encryption::Service`. This crate owns no HTTP authorization.
The worker's `protected_secrets` module adapts the real provider and MCP formats
to that service. The content fixture compares these operations with the actual
TypeScript implementations in both directions using disposable synthetic data.
`protected_content` also supplies the private-state worker helper, retaining
latest-grant selection and missing/corrupt/stale/revoked/recipient error states.
Those helpers take one atomic status/account/key snapshot from the worker service.

Other domain-specific protected content, replay/counter state and encrypted
resource adapters remain worker-port work. The native worker now supplies the
endpoint/surface/repository content helpers and their distinct replay guards;
the owning resource services still enforce authorization and retirement.
The crypto crate reuses `cantrip-framing` for the existing remote-surface binary
payload layout, with no server or transport-runtime dependency. Password/recovery
KDFs and client account-management operations are not implemented here; the
worker uses granted component keys rather than account passwords/master keys.
A generic payload operation alone does not establish those domain contracts.
