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
normalizes validation/authentication failures to the existing generic message.
Validation errors for public configuration/envelopes use the shared contracts.

Tests retain small synthetic TypeScript-produced ciphertext vectors, compare
canonical bytes, and check recipient/context/tamper failures. The worker's
`crypto-fixture` and differential script exercise the unchanged TypeScript
implementation in both directions. Never give those development fixtures a real
profile or secret.

Authenticated grant refresh, domain-specific protected content, replay/counter
state and encrypted stream adapters remain worker-port work. Password/recovery
KDFs and client account-management operations are not implemented here; the
worker uses granted component keys rather than account passwords/master keys.
A generic payload operation alone does not establish those domain contracts.
