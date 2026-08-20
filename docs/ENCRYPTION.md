# Cantrip encryption plan

Cantrip can make most sensitive user content end-to-end encrypted while
leaving the server capable of authentication, synchronization, ordering,
worker routing, scheduling, and relaying.

The target boundary is:

- The server understands ownership, IDs, relationships, ordering, status,
  timestamps, routing, resource sizes, public keys, and opaque key envelopes.
- Clients and explicitly authorized workers understand prompts, responses,
  files, credentials, URLs, paths, workflow inputs, and other private payloads.
- Anything requiring plaintext execution happens on a trusted client or
  worker.

The central schema currently contains 81 durable tables covering identity,
providers, workers, projects, chats, telemetry, and workflows. See
[schema.ts](../cantrip_server/src/db/schema.ts).

## Security goal and threat model

The first security target is precise: an attacker who obtains the complete
Cantrip server database, but does not know the user's password and does not
possess an authorized client or worker private key, cannot decrypt protected
payloads.

This protects against database leaks, leaked backups, and passive inspection of
stored server data. It does not initially protect against:

- a compromised authorized client or worker;
- an actively malicious server process that captures the password during the
  current login protocol or sends abusive commands to a trusted worker;
- modified JavaScript served to a browser by the same server; or
- metadata analysis based on IDs, timing, sizes, counts, routing, and traffic.

Protecting against an actively malicious server requires additional work,
including signed or pinned clients, end-to-end-authorized worker commands, and
eventually a password-authenticated key-exchange protocol that does not reveal
the password to the server. Those properties are not prerequisites for the
database-compromise target above and must not be claimed by the initial
implementation.

## Current state

Some data is already protected, but it is not end-to-end encrypted:

- Passwords use Argon2id hashes and cannot be recovered. Session, CSRF, mobile
  sign-in, enrollment, and worker tokens are also stored as hashes. See
  [service.ts](../cantrip_server/src/auth/service.ts) and
  [schema.ts](../cantrip_server/src/db/schema.ts).
- Provider API keys, ChatGPT/Grok credentials, and MCP secrets use AES-256-GCM
  envelopes. However, the server owns the encryption key and can decrypt them.
  This is database and backup protection, not E2EE. See
  [secret-vault.ts](../cantrip_server/src/security/secret-vault.ts).
- Attachment bytes are stored on workers rather than in the server database.
  The server stores attachment metadata and replica locations. See
  [attachment-store.ts](../cantrip_worker/src/attachment-store.ts) and
  [schema.ts](../cantrip_server/src/db/schema.ts).
- Logs redact known prompts, passwords, credentials, plans, and other sensitive
  fields, although optional persistent service logs remain server-readable.
  See [logger.ts](../cantrip_server/src/logger.ts).

## Key architecture

The login password hash must never be reused as encryption key material.
Password hashes are authentication verifiers, not recoverable encryption keys.

The encryption hierarchy should work as follows:

1. A trusted client generates a random 256-bit Account Master Key.
2. The client derives a temporary key-encryption key from the user's password
   with Argon2id, an independent random salt, versioned parameters, and an
   explicit Cantrip encryption context.
3. The client uses that key-encryption key only to wrap the Account Master Key,
   verifies the wrapper locally, and erases the derived key from memory as soon
   as practical.
4. Each client and worker generates its own public/private encryption keypair.
5. The Account Master Key is separately wrapped to authorized client public
   keys. A client can therefore unlock future sessions without repeatedly
   sending or deriving from the password.
6. Versioned component keys are derived beneath the Account Master Key with
   HKDF and distinct domains for chats, tasks, attachments, credentials,
   workspace names, and later data classes.
7. Each worker receives only the component keys it needs, wrapped to that
   worker's public key with a standard public-key envelope construction. The
   worker can fetch and unwrap those envelopes after a restart without a client
   resending the password.
8. Each payload uses authenticated encryption and binds its owner, component,
   table, row ID, field name, format version, and key revision as associated
   data.

The design should use reviewed, interoperable primitives rather than a custom
encryption construction. Relevant baselines include
[Argon2id](https://www.rfc-editor.org/rfc/rfc9106.html),
[HKDF](https://www.rfc-editor.org/rfc/rfc5869.html),
[HPKE](https://www.rfc-editor.org/rfc/rfc9180.html), and an authenticated
encryption mode such as AES-GCM.

### Foundation format version 1

The shared endpoint implementation lives in `@cantrip/crypto`; its bounded
wire and persistence schemas live in `@cantrip/protocol`. Format version 1 is
fixed to:

- Argon2id version 1.3 (`v=19`) for the password key-encryption key, with a
  32-byte independent random salt, 32-byte output, 64 MiB memory, three
  iterations, one lane, and the `cantrip:e2ee:password-kek:v1`
  personalization context. Stored parameters are versioned and bounded so a
  future profile can deliberately adopt stronger settings.
- HKDF-SHA-256 for 32-byte component, field, and blind-lookup key derivation.
  Component, field, and lookup keys use separate Cantrip domains. Blind
  lookup tags use HMAC-SHA-256 with the separately derived lookup key.
- AES-256-GCM for authenticated payload and password-wrapper envelopes, with a
  fresh random 12-byte nonce and a 128-bit authentication tag for every
  encryption.
- RFC 9180 base-mode HPKE with DHKEM(P-256, HKDF-SHA-256) (`0x0010`),
  HKDF-SHA-256 (`0x0001`), and AES-256-GCM (`0x0002`) for device and worker key
  wrapping. P-256 public keys use the 65-byte uncompressed SEC1 format.
- Canonical unpadded base64url for byte fields and canonical JSON associated
  data binding owner ID, component, table, row ID, field, format version, and
  key revision.

The implementation uses `@noble/hashes` 2.3.0 for Argon2id and HKDF/HMAC and
`@hpke/core` 1.9.0 for WebCrypto-backed HPKE. It rejects unknown versions,
noncanonical encodings, wrong keys or recipients, changed associated data, and
authentication failures. Sensitive byte buffers are cleared on a best-effort
basis after use; JavaScript strings and runtime-managed copies cannot be
reliably erased.

The shared primitive package does not unlock a client or worker or encrypt a
product payload by itself. The server persists the hierarchy's opaque profiles,
public principals, and wrapped grants. Client and worker custody are implemented
below, and workspace display names are the first product payload using them.

### Opaque key registry

The server registry is implemented by
[migration 0100](../cantrip_server/drizzle/0100_giant_medusa.sql),
[encryption-registry.ts](../cantrip_server/src/db/encryption-registry.ts), and
the authenticated routes in [app.ts](../cantrip_server/src/app.ts). It stores:

- one versioned encryption profile per owner, including the active Account
  Master Key revision, independent password KDF record, password-wrapped
  Account Master Key, explicit initialization state, payload-migration state,
  and optimistic revision;
- client and worker principals with public keys, approval state, optimistic
  revisions, and revocation metadata; and
- client Account Master Key wrappers or scoped worker component-key grants as
  bounded opaque JSON envelopes with their own key and record revisions.

First-profile creation transactionally inserts the profile, initial approved
client principal, and its wrapped Account Master Key grant. A conflicting
initializer receives the already-established profile instead of overwriting
it. Every registry operation derives the owner from the authenticated request;
worker principals additionally require a currently enrolled worker belonging to
that owner. Pending or revoked principals cannot fetch or receive active
grants, and principal revocation also revokes its existing grants.

The server validates envelope shape and identity-binding metadata but neither
imports `@cantrip/crypto` nor derives, unwraps, or decrypts keys. The focused
[registry API test](../cantrip_server/test/encryption-registry-api.test.ts)
covers initialization compare-and-set behavior, owner isolation, worker
binding, revocation, byte-preserving opaque storage, migration application,
the worker-authenticated registration and delivery path, and the server
dependency boundary.

### Client key custody

The browser client custody boundary is implemented by
[client-encryption.ts](../cantrip_app/src/lib/client-encryption.ts). Each
browser installation generates its own nonextractable WebCrypto P-256 private
key and stores it as a structured-cloned `CryptoKey` in IndexedDB. Its
versioned local record and storage key bind the device to one server ID and one
owner ID. The storage interface is deliberately replaceable so native clients
can later use an operating-system key store without changing the encryption
service contract.

The service can create and open password and client Account Master Key
wrappers, derive component keys, and expose stable locked, unavailable,
revoked, corrupt, and unsupported-version states. Plaintext Account Master
Keys and derived component keys exist only in memory; service-owned copies are
cleared on lockout, sign-out, account replacement, and server switching.
Passwords, password-derived keys, raw Account Master Keys, component keys, and
extractable private keys are never written to IndexedDB or local storage.

The focused [client custody test](../cantrip_app/src/lib/client-encryption.test.ts)
proves nonextractability, device-wrapper unlock after a simulated restart,
password-wrapper unlock, server/account isolation, sign-out clearing, and
fail-closed handling for corrupt, revoked, and unsupported state. It also
accepts the WebIDL `FrozenArray` representation that WebKit may return for a
structured-cloned `CryptoKey.usages`, so that valid desktop representation is
not misclassified as a corrupt device key during encrypted workspace creation.
The
[server connection test](../cantrip_app/src/lib/server-connections.test.ts)
also verifies that switching servers locks in-memory encryption keys.

An irreparably malformed local device record is different from an unknown
future format. The client deletes and replaces only a malformed local
nonextractable key, then requires the normal password or recovery wrapper once
to authorize the replacement key. Unknown versions remain untouched and fail
closed so a newer client may still recover them. If this condition is found
while the application is already mounted (for example after a development hot
reload), a protected workspace mutation returns the application to sign-in
instead of leaving an unusable modal open. No server-held principal or grant
can authorize the replacement without that credential step.

Nonextractable browser keys are still usable by JavaScript running in the same
origin, so they do not protect against a malicious server that changes the
served application. Clearing site data also deletes the device key and
requires another recovery or authorization path. Account initialization and
the workspace-name adapter consume this custody boundary as described below.

### Account initialization and unlock

The client orchestration in
[account-encryption.ts](../cantrip_app/src/lib/account-encryption.ts) and the
gate in
[application-session.tsx](../cantrip_app/src/components/auth/application-session.tsx)
now initialize or unlock encryption before the application router mounts.
Registration and interactive sign-in reuse the password already present in
the form for that one operation. An existing cookie session with no profile,
or a new device with no wrapper, receives a focused reauthentication prompt.
The password is passed directly to the encryption operation, never stored, and
is not requested again after that device has an active wrapper.

On later sessions the client loads its nonextractable device key, fetches its
opaque approved principal and Account Master Key grant, and unlocks without a
password. A new device uses the password wrapper once, then creates and
receives its own approved principal and device wrapper. The initialization
compare-and-set safely handles two clients racing: the loser discards its
candidate Account Master Key, opens the winning profile with the password, and
authorizes its device against that existing key. Missing, conflicting,
revoked, malformed, or unknown-version state never opens the application or
permits protected-data mutations.

Anonymous local mode generates a random recovery secret, uses it to wrap the
Account Master Key, and displays it once. The server stores only the
independently salted wrapper; the secret is neither persisted by the client nor
sent as a server-readable convenience key. A later local device must present
that recovery secret. Losing it and every authorized endpoint makes the data
unrecoverable.

Password rewraps are locally opened and compared with the in-memory Account
Master Key before submission. For account password changes,
[the server operation](../cantrip_server/src/db/encryption-registry.ts)
verifies the current password and transactionally updates both the
authentication verifier and the new opaque password wrapper under an
optimistic profile revision. The Account Master Key, payload ciphertext, and
device or worker grants do not change. A forgotten-password reset still
requires an already authorized client or separately held recovery material;
there is intentionally no server-only reset path that replaces the encryption
root.

The focused
[client initialization test](../cantrip_app/src/lib/account-encryption.test.ts)
covers first initialization, existing-session prompting, new-device and
restart unlock, incorrect passwords, concurrent initialization, anonymous
recovery, locked mutation behavior, and password rewrap continuity. The
[registry integration test](../cantrip_server/test/encryption-registry-api.test.ts)
also verifies server reauthentication and atomic password/verifier-wrapper
replacement.

### Persistent worker key custody and scoped grants

The worker custody boundary is implemented by
[worker-encryption.ts](../cantrip_worker/src/worker-encryption.ts). Each worker
creates a P-256 encryption keypair and a random principal ID. The initial
portable fallback stores the private key in a versioned
`worker-encryption-key.json` record under the worker data directory, written
atomically with mode `0600`. The record binds the key to the server origin,
owner ID, worker ID, public key, principal ID, and highest accepted revision
per component. A record from another server, account, or worker fails closed.
Future native workers can replace this file boundary with an OS-backed secret
store without changing the wire protocol.

After worker-credential enrollment, the worker registers its public key at the
worker-authenticated `/api/internal/workers/encryption/bootstrap` endpoint.
The server creates only a pending public principal. An unlocked authorized
client must approve that principal and create each HPKE component-key envelope
through [worker-encryption-grants.ts](../cantrip_app/src/lib/worker-encryption-grants.ts).
The server has no operation that derives a component key or manufactures a
usable grant. The protocol makes both the Account Master Key and the
`workspace-display-name` component structurally ungrantable to workers.

The same bootstrap endpoint returns active opaque grants after approval. The
worker unwraps only the newest revision for each scope, rejects revision
rollback, clears revoked or absent scopes from memory on a successful refresh,
and never persists plaintext component keys. On restart it reloads its private
key and fetches the same server-held envelopes, so it does not need the user,
client, password, or password-derived key. Encryption readiness and granted
component revisions are included in worker heartbeat status; the server can
route based on that metadata but cannot use it to decrypt.

The focused [worker custody test](../cantrip_worker/src/worker-encryption.test.ts),
[client grant test](../cantrip_app/src/lib/worker-encryption-grants.test.ts),
and [registry integration test](../cantrip_server/test/encryption-registry-api.test.ts)
cover file permissions, identity binding, client-only grant creation, intended
recipient decryption, restart recovery, scope denial, revision replacement,
revocation, and opaque authenticated delivery. An unattended authorized
worker is deliberately a persistent decryption endpoint: compromise of that
host exposes every component granted to it. Narrow grants limit this blast
radius but do not remove it.

Task operations now use the first component-specific readiness gate in
[task-worker-encryption.ts](../cantrip_app/src/lib/task-worker-encryption.ts).
Before planning, replanning, continuing, or beginning implementation, an
unlocked client checks the assigned worker's heartbeat metadata against the
active Account Master Key revision. Pending, missing, or stale authorization
is repaired by approving that worker and wrapping only `task-content`; locked,
offline, revoked, unsupported, wrong-worker, and still-stale states fail
closed with a visible status. No password prompt is added.

The client then requests an immediate scoped refresh through the server. The
server authenticates ownership and relays only the component and requested
revision. The worker fetches the already-wrapped grant through its authenticated
bootstrap path, unwraps it with its persistent private key, and returns opaque
readiness metadata. The Task operation is not submitted unless the worker
reports the exact `task-content` revision. The server cannot create the grant,
obtain the component key, or bypass the gate with a plaintext fallback.

### What each system stores

The server stores:

- the normal login password hash;
- a different encryption salt and versioned KDF parameters;
- the password-wrapped Account Master Key;
- client and worker public keys;
- separately wrapped client master-key and worker component-key grants;
- ciphertext, encryption versions, key revisions, and necessary plaintext
  routing metadata.

The server does not store the password-derived key-encryption key, private
device keys, plaintext Account Master Key, plaintext component keys, or
decrypted payloads.

An authorized client stores its private device key in an appropriate local
store. Native clients should prefer the operating-system keychain or hardware
store. A browser can use a nonextractable WebCrypto key in IndexedDB, with the
weaker browser threat boundary documented. Decrypted master and component keys
should otherwise remain in memory.

An authorized worker stores its private key in an operating-system key store
or a protected worker-local file with restrictive permissions. It may persist
server-provided wrapped component-key envelopes, but never the user's password
or password-derived key. Unwrapped component keys remain in memory while the
worker is running.

An unattended worker necessarily has persistent decryption capability. A
compromise of that worker host exposes every component granted to it. Scoped
worker grants limit that blast radius and should be preferred over giving every
worker the Account Master Key.

### Password changes and recovery

Changing the login password must not require re-encrypting user data or
reissuing worker grants:

1. An already unlocked client obtains the existing Account Master Key from its
   device wrapper or the old password wrapper.
2. It derives a new key-encryption key from the new password with a fresh
   encryption salt and current KDF parameters.
3. It wraps the same Account Master Key, verifies the new wrapper locally, and
   submits the replacement wrapper and password change with revision checking.
4. The server atomically replaces the authentication verifier and password
   wrapper. Payload ciphertext, client wrappers, and worker component grants
   remain unchanged.

A password reset cannot silently replace the encryption root. If the old
password is unavailable, an authorized client or a separately generated
recovery key must recover the Account Master Key and create a new password
wrapper. If the password, recovery key, and all authorized client keys are
lost, unrecoverability is an expected E2EE property rather than an
implementation defect. Existing workers may continue using component keys
already granted to them, but they must not automatically authorize a new
client or replace the account recovery wrapper.

### Database-compromise property

A complete database contains both the authentication verifier and the
password-wrapped Account Master Key. The authentication hash bytes are not a
decryption key and cannot directly unwrap the Account Master Key because the
encryption KDF uses an independent salt, context, and output.

The database still permits offline password guessing: an attacker who guesses
the actual password can derive the encryption key-encryption key and attempt to
open the master-key wrapper. Argon2id raises the cost of each guess but cannot
make a weak password strong. This limitation must be stated anywhere the
database-compromise guarantee is described.

## Feasibility and rollout ledger

| Data class                                                                       | Current protection                                                                                           | Rollout status                                    | E2EE feasibility     | Complexity  | What the server loses                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| Shared encryption formats and cryptographic primitives                           | Versioned endpoint-only primitives                                                                           | Foundation complete                               | Required             | Medium      | No server decryption capability is introduced                                                  |
| Account profiles, client wrappers, and scoped worker grants                      | Opaque versioned registry; no server key access                                                              | Registry foundation complete                      | Required             | High        | Password-based server recovery and direct inspection of key material                           |
| Client device-key custody and in-memory key handling                             | Nonextractable IndexedDB key; memory-only AMK                                                                | Client custody complete                           | Required             | Medium      | No server decryption capability is introduced                                                  |
| Account initialization, device authorization, and password lifecycle             | Client-only initialization and unlock                                                                        | Client initialization complete                    | Required             | High        | Server-only password reset and plaintext recovery                                              |
| Worker key custody, public registration, and scoped component grants             | Protected local private key; opaque server grants; Task operations require exact scoped readiness            | Worker grants and Task readiness complete         | Required             | High        | Server cannot create grants or run plaintext work without an authorized worker                 |
| Workspace display names                                                          | AES-256-GCM E2EE; client-only key                                                                            | E2EE complete; lazy migration                     | Implemented          | Low-Medium  | Name-based server search and validation                                                        |
| Project display names                                                            | AES-256-GCM E2EE; client-only key; project-domain pre-release reset                                          | E2EE complete                                     | Implemented          | Medium      | Independent label search and presentation; repository identity remains queryable               |
| Ordinary agent-chat message bodies, reasoning, command output, diffs, file paths | Plaintext                                                                                                    | Planned                                           | Excellent            | High        | Full-text search, previews, content notifications, server-side summarization                   |
| Task briefs, plans, questions, answers, directions, errors, messages, and Goals  | AES-256-GCM E2EE across Task rows, planning rounds, Task messages, Goal APIs, live events, and relocation    | E2EE complete                                     | Excellent            | Medium-High | Server cannot inspect, transform, reconstruct, or search protected Task content                |
| Ordinary chat and Task display titles                                            | AES-256-GCM E2EE; client-created labels and scoped worker-created import labels                              | E2EE complete                                     | Implemented          | Medium      | Title search, concatenation, automation copies, and execution-target presentation              |
| Queued prompts                                                                   | Plaintext                                                                                                    | Planned                                           | Excellent            | Medium      | Server cannot dispatch prompt content without an authorized endpoint                           |
| Attachment bytes, filenames, MIME, previews                                      | Bytes are worker-local; metadata is plaintext                                                                | Planned                                           | Excellent            | Medium      | Server-side previews, malware scanning, content deduplication                                  |
| Interaction and approval request details and responses                           | Plaintext                                                                                                    | Planned                                           | Excellent            | Medium      | Server can route approvals but cannot display or validate their semantics                      |
| Surface private-state contracts, endpoint codecs, and scoped worker grants       | Bounded `surface-private-state` envelopes; independently grantable from display labels                       | Contract foundation complete; persistence pending | Required             | Medium      | No server decryption capability is introduced                                                  |
| Terminal working directories and service commands                                | Plaintext production persistence and execution                                                               | Persistence switch planned                        | Excellent            | Medium      | Server cannot inspect or synthesize launch paths or service commands                           |
| Explorer selected path                                                           | Plaintext production persistence                                                                             | Persistence switch planned                        | Excellent            | Low-Medium  | Server cannot restore or inspect the selected entry                                            |
| Browser initial, current, and navigated URLs                                     | Plaintext production persistence and relay                                                                   | Persistence switch planned                        | Excellent            | Medium      | Server cannot search, validate, or diagnose browser destinations                               |
| Remote Desktop target selection and private inventory details                    | Plaintext production persistence and relay                                                                   | Persistence switch planned                        | Excellent            | Medium-High | Server cannot inspect targets, application names, window titles, or monitor labels             |
| Terminal interactive input and output                                            | Plaintext or relayed content                                                                                 | Planned separately                                | Excellent            | High        | Server cannot inspect shell interaction content                                                |
| Explorer operation paths, entries, Git paths, and file/media contents            | Plaintext or relayed content                                                                                 | Planned separately                                | Excellent            | High        | Server cannot inspect filesystem operations or content                                         |
| Browser page content, cookies, credentials, profiles, screenshots, and frames    | Plaintext or relayed content                                                                                 | Planned separately                                | Excellent            | High        | Server cannot inspect or diagnose browser session content                                      |
| Remote Desktop frames, input, and clipboard                                      | Relayed content                                                                                              | Planned separately                                | Excellent            | High        | Server cannot inspect or transform desktop session content                                     |
| Surface and project-view display labels                                          | AES-256-GCM E2EE; client-created row-bound labels; canonical browser/desktop copies only                     | E2EE complete                                     | Implemented          | Medium      | Server retains routing and ordering but loses name-based search and synthesis                  |
| Custom tab-group display labels                                                  | AES-256-GCM E2EE for custom labels; unnamed groups derive from decrypted members client-side                 | E2EE complete                                     | Implemented          | Medium      | Server retains layout structure but cannot present or synthesize group labels                  |
| Private display-label server boundary and lifecycle audit                        | Generated route inventory, repository/schema guards, endpoint restart proof, full temporary-DB sentinel scan | Closure audit complete                            | Required             | Medium      | Server builds and persists only opaque label contracts                                         |
| Policies and agent instructions                                                  | Plaintext                                                                                                    | Planned                                           | Very good            | Medium-High | Server cannot compose prompts; the worker must do it                                           |
| Provider API keys, ChatGPT/Grok credentials, MCP secret headers and environment  | Server-decryptable AES-256-GCM                                                                               | Planned replacement                               | Very good            | High        | Credential refresh, provider testing, and catalog discovery must move to a worker or client    |
| MCP commands, URLs, and nonsecret configuration                                  | Plaintext                                                                                                    | Planned                                           | Good                 | High        | Server cannot validate or describe configuration if fully encrypted                            |
| Workflow prompts, definitions, structured inputs, and results                    | Plaintext                                                                                                    | Planned                                           | Good when split      | Very high   | Scheduler can route opaque jobs, but conditions and content evaluation must happen on a worker |
| Repository identities and names, remotes, paths, branch names, and Git output    | Plaintext                                                                                                    | Planned partial encryption                        | Partial              | High        | Server orchestration currently depends on some of this data                                    |
| Token usage, quotas, and model-behavior analytics                                | Plaintext/queryable                                                                                          | Planned minimization                              | Partial              | Medium-High | Fully encrypting numbers removes server dashboards, budgets, and historical analysis           |
| Diagnostic logs and audit metadata                                               | Redacted but server-readable                                                                                 | Planned minimization                              | Partial              | Medium      | Fully encrypted logs prevent server-side operations and security investigation                 |
| Worker platform, capabilities, online state, and tunnel endpoints                | Plaintext                                                                                                    | Intentionally plaintext                           | Poor                 | High        | The server cannot route sessions or decide which worker supports a feature                     |
| Workflow status, leases, retries, dependencies, and deadlines                    | Plaintext                                                                                                    | Intentionally plaintext                           | Poor                 | Very high   | The server cannot schedule or recover jobs                                                     |
| User IDs, roles, account status, licenses, and memberships                       | Plaintext                                                                                                    | Do not encrypt                                    | Do not encrypt       | -           | The server must enforce authorization                                                          |
| Sessions, enrollment codes, and worker credentials                               | Hashed                                                                                                       | Keep hashed                                       | Do not encrypt; hash | -           | The server must validate them                                                                  |
| Opaque IDs, foreign-key relationships, ordering, and timestamps                  | Plaintext                                                                                                    | Usually keep plaintext                            | Usually plaintext    | -           | Needed for synchronization and routing                                                         |
| Public provider model catalogs and system state                                  | Plaintext/public                                                                                             | No encryption benefit                             | No benefit           | -           | Generally public or operational data                                                           |

The rollout status must be updated as each component lands. A row is not
`E2EE complete` while any normal write path stores plaintext or while legacy
plaintext remains without an explicit migration state.

### Workspace display names

Workspace display names are the first production payload encrypted through
the shared foundation. The app-side
[workspace adapter](../cantrip_app/src/lib/workspace-encryption.ts) allocates
the row ID, derives the `workspace-display-name` field and lookup keys, and
encrypts each name with format-version-1 AES-256-GCM before create or rename
requests leave the client. Associated data binds the owner, component,
`project_workspaces` table, row ID, `name` field, format version, and key
revision. Decryption occurs only in that adapter after an authenticated
response reaches an unlocked client; presentation and client-side search
continue to use a decrypted `ProjectWorkspaceSummary`.

The server retains the workspace and owner IDs, membership relationships,
position, default status, timestamps, optimistic revision, format and key
revision, bounded envelope, and a 32-byte HMAC-SHA-256 blind uniqueness tag.
The tag is derived with the separate HKDF lookup-key domain over the trimmed,
NFKC-normalized, lowercase name. The server can enforce per-owner uniqueness
but cannot calculate the tag or recover the name. Effective-policy responses
now carry only workspace IDs; the client resolves their display labels after
decrypting the workspace list. The workspace component remains structurally
ungrantable to workers.

[Migration 0102](../cantrip_server/drizzle/0102_minor_klaw.sql) permits either
a complete legacy plaintext state or a complete encrypted state, never a
mixture. Once an authorized client unlocks, it receives the explicit remaining
legacy count and locally replaces each plaintext name with its envelope and
blind tag under optimistic revision checking. Concurrent migrations are
idempotent: a revision conflict is followed by a refetch, and plaintext is
removed atomically on success. Normal API writes accept only the encrypted
wire representation, and repository compatibility paths reject plaintext
names after the owner's encryption profile exists.

The focused
[client adapter test](../cantrip_app/src/lib/workspace-encryption.test.ts) and
[temporary-database persistence test](../cantrip_server/test/workspace-name-encryption.test.ts)
cover create, list, rename, client search, locked mutations, row-bound envelope
authentication, normalized duplicate tags, revision-safe idempotent migration,
and a zero-legacy-row result while retaining ordering, default, and membership
metadata. This earns `E2EE complete` for normal writes and the tested migrated
database. Real deployments migrate lazily when each owner next opens an
authorized unlocked client, so inactive owners can still have explicitly
reported legacy plaintext rows until then; this document does not claim those
deployed rows are already migrated.

### Project display names

Project display names are the first protected-label payload moved from the
shared contract into production persistence. The
[project adapter](../cantrip_app/src/lib/project-encryption.ts) allocates the
project UUID, derives the `private-surface-metadata` component key, and
encrypts the name before either GitHub or managed-folder creation leaves the
client. The same adapter decrypts opaque project summaries and performs
display-name sorting locally. Locked, corrupt, tampered, or row-swapped labels
fail closed rather than falling back to repository identity or another
server-visible value.

The server stores `projects.protected_label`, validates only its bounded wire
shape and `project` classification, and never imports the shared crypto
package. Project list, create, setup, preferred-worker, and worktree-policy
responses remain opaque until the trusted client adapter opens them.
Repository identity (`github_repository_id`, repository full name, and URL),
source and worktree paths, Git state, placement, ordering, and setup status are
still plaintext operational metadata and remain separate ledger work. Project
folder materialization and Code launch use project UUIDs and worker-local path
basenames, so workers do not receive a project-label key grant merely for
setup. Secondary external-chat-import references no longer copy the project
display name. A GitHub project's initial visible label is derived from its
plaintext repository full name, so a database reader can infer that initial
label even though the dedicated protected field is opaque. The E2EE status
applies to project-label persistence, not repository-identity confidentiality.

[Migration 0105](../cantrip_server/drizzle/0105_superb_energizer.sql)
deliberately deletes every project before replacing the required plaintext
`name` column with required opaque `protected_label` storage. This is a
pre-release reset, not a legacy-data migration: project-owned rows and
memberships cascade away, while users, sessions, account encryption profiles,
principals, grants, workers and credentials, account settings, and workspace
rows are preserved. No real local or deployed database is modified by the
focused tests.

The focused
[client adapter test](../cantrip_app/src/lib/project-encryption.test.ts),
[project setup API tests](../cantrip_server/test/project-folder-api.test.ts),
and
[temporary migration test](../cantrip_server/test/project-label-reset-migration.test.ts)
cover encrypted create/list round trips, client-side sorting, locked writes,
wrong-row and tamper rejection, opaque server and worker commands, and exact
reset preservation. Project display names therefore earn `E2EE complete`;
repository names, URLs, and paths do not.

## Chats and tasks

Ordinary agent chats remain a high-value future E2EE candidate. Their message
content stays in `chat_messages.content`, while routing and ordering are
separate fields such as chat ID, sequence, role, worktree, model route, and
timestamp. Task-experience chats now use a separate encrypted message shape;
Task rows and planning rounds likewise separate public workflow state from
encrypted sensitive prose. Ordinary-chat and Task titles now use the shared
`private-surface-metadata` protected-label contract. Clients allocate the chat
ID before encrypting, while external-import workers use their scoped component
grant to encrypt the source title for the already allocated import/job ID.

Cantrip Server persists only `chats.protected_label`. It no longer appends
`(fork)`, joins titles into automation records, copies imported titles into job
metadata, or exposes a plaintext chat title through archives, relocation,
execution-target catalogs, or tab-layout summaries. Fork labels are derived
and encrypted by the client. Project automation presentation resolves the
already-decrypted chat list, and default tab-group titles are derived from
decrypted members in the client. Ordinary agent-chat message bodies remain
plaintext and are tracked separately above.

[Migration 0106](../cantrip_server/drizzle/0106_wandering_squadron_sinister.sql)
adds the required opaque column and removes `chats.title`. It deliberately does
not translate existing titles: the Cycle 2 project-domain reset already left
project-owned chat rows empty, so no second database wipe or compatibility
reader is required.

The server can retain chat ID, project ID, message sequence, role, timestamp,
running state, worker and worktree placement, model-route identifiers,
ciphertext, and encryption version. An authorized worker can decrypt the
component key at startup, build context and local indexes, compact or fork a
conversation, and upload new ciphertext without asking the client for the
password.

The main behavioral change is that search, compaction, and other content-aware
operations require an online authorized endpoint. The server can no longer do
them independently.

### Surface and project-view display labels

Terminal, Explorer, Code-tab, browser, standalone Remote Surface, managed
Remote Desktop, History, and Issues display titles now use the shared
`private-surface-metadata` component. The client allocates each UUID before
create, encrypts the title with the matching record kind, and decrypts the
opaque wire summary only after it reaches the trusted app boundary. Defaults
such as `Terminal`, `Explorer`, `Code`, `Browser`, `Remote Desktop`, and a
chat's linked `Console` are therefore created and encrypted by the client; the
server has no default-title synthesis path.

The canonical columns are `terminals.protected_label`,
`explorers.protected_label`, `code_tabs.protected_label`,
`browsers.protected_label`, and `project_views.protected_label`. A standalone
row uses `remote_surfaces.protected_label`. Managed browser and desktop rows do
not copy their titles into `remote_surfaces`: those wire summaries join the
canonical browser or project-view ciphertext by the shared row ID. Browser
URLs, terminal and Explorer paths, Code runtime state, remote target/window
inventory, placement, status, and operational errors remain plaintext and are
still tracked separately in the ledger.

Execution-target catalogs and tab-layout members carry only the row-bound
opaque label for these surfaces. The client authenticates and opens it before
presentation, then derives an unnamed tab group's visible title from its
decrypted anchor. The server can still route by opaque ID and surface kind,
but its CLI can select protected surfaces only by full or unambiguous ID—not by
display title. Custom multi-tab group titles use their own protected group-row
envelope as described below.

[Migration 0107](../cantrip_server/drizzle/0107_quick_switch.sql) adds the
opaque columns and removes all six legacy `title` columns. It intentionally
has no plaintext conversion or compatibility reader: this pre-release rollout
assumes disposable project-domain data and a fresh/reset database. It does not
change the password wrapper, Account Master Key, client or worker principal,
or scoped grants.

The focused
[client adapter test](../cantrip_app/src/lib/surface-title-encryption.test.ts),
[execution placement API test](../cantrip_server/test/project-placement-api.test.ts),
[Remote Desktop fleet test](../cantrip_server/test/remote-desktop-fleet-api.test.ts),
and
[temporary-database persistence test](../cantrip_server/test/surface-title-persistence.test.ts)
cover every record kind, row-bound opening, replay rejection, opaque catalog
copies, canonical managed-surface storage, and removal of plaintext title
columns. Surface and project-view display labels therefore earn `E2EE
complete`; the operational URL, path, target, and runtime fields named above
do not.

### Custom tab-group display labels

Custom multi-tab group titles now use the same `private-surface-metadata`
component with the `tab-group` record kind. The app encrypts a rename against
the existing group ID before sending the revisioned update. The server stores
only nullable `tab_groups.protected_label`; null means that the trusted client
derives the visible title from the already-decrypted anchor member. A custom
envelope is allowed only while the group has multiple members.

Tab-layout wire summaries contain group IDs, project IDs, ordering, anchor
keys, revisions, timestamps, nullable group ciphertext, and member
ciphertext. They contain no plaintext member or group title. Reorder and move
operations need only opaque IDs and positions. Split, detach, and merge paths
clear a custom group envelope when the source becomes a single-tab group, so
the server never needs to reconstruct or compare a display label.

[Migration 0108](../cantrip_server/drizzle/0108_lowly_changeling.sql) adds the
nullable opaque column and removes `tab_groups.title`. Like the preceding
project-domain migrations, it intentionally has no plaintext conversion or
compatibility reader and assumes the documented pre-release reset/fresh
database.

The focused
[client title-adapter test](../cantrip_app/src/lib/chat-title-encryption.test.ts),
[layout API test](../cantrip_server/test/project-placement-api.test.ts), and
[temporary-database persistence test](../cantrip_server/test/tab-group-title-persistence.test.ts)
cover client-side default derivation, encrypted custom renames, mixed member
kinds, reorder, split, merge, stale revisions, restart restoration, wrong-row
replay, swapped classifications, tampering, and absence of plaintext sentinel
labels or a legacy title column. Custom tab-group display labels therefore earn
`E2EE complete`.

### Private display-label contract foundation

The shared `private-surface-metadata` foundation now defines one versioned,
bounded protected-label bundle for project names; ordinary-chat and Task
titles; terminal, Explorer, code-tab, browser, and remote-surface titles; and
project-view and tab-group titles. The opaque
[wire contract](../packages/protocol/src/private-labels.ts) exposes only the
record kind and encrypted envelope. The decrypted label is a separate trusted
endpoint type, and the encrypted bundle repeats the record kind so decryption
can reject disagreement between public and protected metadata.

The shared [endpoint codec](../packages/crypto/src/private-labels.ts) binds the
owner, `private-surface-metadata` component, exact table, row ID,
`protected_label` field, format version, and key revision as authenticated
associated data. Every record kind maps to one table and therefore cannot be
replayed as another kind. The trusted
[client adapter](../cantrip_app/src/lib/private-label-encryption.ts) derives
the component key only while the account is unlocked. The trusted
[worker adapter](../cantrip_worker/src/private-label-encryption.ts) uses only
an active scoped grant. Worker readiness and authorization reuse the generic
grant registry through
[private-label-worker-encryption.ts](../cantrip_app/src/lib/private-label-worker-encryption.ts),
so an approved worker can restore its wrapped component key after restart
without receiving the password.

The adapters fail closed with explicit locked, missing, revoked, stale,
corrupt, and unsupported states. Focused protocol, shared-codec, client,
worker, and readiness tests cover every record kind, classification agreement,
associated-data swaps, tampering, bounds, intended-worker isolation, and
restart recovery. Project names, ordinary-chat and Task titles, surface and
project-view titles, and custom tab-group titles now use this contract in
production persistence. The ledger keeps operational URLs, paths, selections,
and content in separate rows rather than overstating the protected-label
boundary.

### Surface private-state contract foundation

Operational surface state uses a separate `surface-private-state` component;
it does not reuse `private-surface-metadata`. A worker can therefore be granted
the terminal, Explorer, browser, or Remote Desktop state it needs to execute
without also receiving display-label access. This foundation adds only shared
contracts and trusted endpoint machinery. The production columns and commands
named in the four pending ledger rows remain plaintext until their dedicated
persistence-switch cycles merge.

The bounded opaque
[wire contract](../packages/protocol/src/surface-private-state.ts) defines
distinct public classifications and trusted decrypted types for terminal
directory/service-command state, Explorer selection state, browser URL state,
Remote Desktop target state, and worker-generated target inventory. Persistent
row resources and ephemeral operation resources are separate. Ephemeral
resources require an operation ID, while persistent resources reject one.

The shared
[endpoint codec](../packages/crypto/src/surface-private-state.ts) derives a
field key beneath `surface-private-state`, encrypts canonical versioned JSON
with AES-256-GCM and a fresh nonce, and binds the owner, hashed server identity,
exact table or protocol resource, row/surface ID, operation ID, record kind,
bundle field, format version, and key revision. A bundle cannot be replayed
across accounts, servers, rows, surfaces, operations, fields, kinds, or
persistent/ephemeral resources.

The trusted
[client adapter](../cantrip_app/src/lib/surface-private-state-encryption.ts)
uses the existing nonextractable device-wrapper unlock and never persists the
Account Master Key or component key. The trusted
[worker adapter](../cantrip_worker/src/surface-private-state-encryption.ts)
opens only its active scoped grant. The
[readiness helper](../cantrip_app/src/lib/surface-private-state-worker-encryption.ts)
authorizes and refreshes only `surface-private-state`, independently of the
display-label grant. Endpoint states distinguish locked, missing,
missing-grant, revoked, stale, corrupt, wrong-recipient, and unsupported data.

Focused protocol, crypto, client, worker, custody, and readiness tests cover
all five bundle kinds, bounds, client/worker codec agreement, associated-data
swaps, tampering, unknown versions, locked clients, intended-worker isolation,
revocation, and client/worker restart recovery without resending a password.
Cantrip Server does not import these trusted codecs, and this foundation does
not claim that any production surface-state persistence is encrypted yet.

### Private display-label closure audit

The generated
[server route inventory](security/server-route-inventory.json) now records an
enforced private-display-label boundary alongside the Task boundary. Its
[generator](../scripts/audit-server-boundaries.mjs) scans every production
server TypeScript file and fails if the server imports a trusted plaintext
label schema, endpoint decryption helper, shared crypto implementation, or
client/worker encryption adapter. It inventories the opaque list, create,
update, archive, restore, fork, linked-console, Remote Desktop, execution-target,
and tab-layout route contracts rather than relying on a hand-maintained route
list alone.

The same audit checks that `projects`, `chats`, `terminals`, `explorers`,
`code_tabs`, `browsers`, `remote_surfaces`, `project_views`, and `tab_groups`
have `protected_label` JSONB storage and no former plaintext `name` or `title`
column. Repository serializers must remain wire-only; tab layouts must carry
opaque member/group labels; and import and relocation jobs must copy the
authenticated envelope rather than rebuild a title. Trusted plaintext schemas
remain available only to endpoint code after decryption; their import from
Cantrip Server is prohibited.

The focused
[app lifecycle test](../cantrip_app/src/lib/private-label-lifecycle.test.ts)
creates a project, ordinary chat, Task, every surface kind, project view, and
custom tab group, verifies that their wire state contains no sentinel label,
then reopens all of them after a simulated process restart through the same
authorized nonextractable device key. The consolidated
[temporary-database test](../cantrip_server/test/surface-title-persistence.test.ts)
creates the same persistence families (including encrypted Task content),
closes the repository, reopens its disposable PGlite database, scans every
public table for sentinel plaintext, and checks all nine covered tables lack
their former plaintext label column. It does not connect to or wipe a user
development database.

### Task content contract foundation

The first Task milestone defines the production encryption boundary without
yet changing Task persistence. The versioned contracts in
[tasks.ts](../packages/protocol/src/tasks.ts) provide separate opaque wire
summaries for Task rows, planning rounds, Task-experience messages, and Goal
objective snapshots. Each summary carries only the public state needed for
routing and optimistic transitions plus a bounded `task-content` envelope.
The corresponding encrypted bundle repeats server-required classifications,
including state, operation kind, plan authorship, artifact-presence flags,
message role and mode, attachment IDs, planning-round status, and Goal status.

Trusted clients and workers share the codecs in
[task-content.ts](../packages/crypto/src/task-content.ts). They derive a
separate field key for each bundle with HKDF-SHA-256, encrypt the canonical
versioned JSON with AES-256-GCM, and bind the owner, `task-content` component,
table, row ID, bundle field, format version, and key revision as associated
data. Decryption fails closed for a changed owner, row, table or field,
tampering, unsupported versions, wrong revisions, oversized content, or any
disagreement between the encrypted and public classification. Plaintext byte
buffers and derived field keys are cleared on a best-effort basis.

The focused [protocol contract test](../packages/protocol/test/task-encryption.test.ts)
and [endpoint codec test](../packages/crypto/test/task-content.test.ts) cover
all four bundles and their failure boundaries. Cantrip Server does not import
these codecs. The production Task persistence, message, Goal, live-event, and
relocation paths now consume these contracts.

### Encrypted Task execution relay

The encrypted execution transport is implemented before the persistence
switch. An unlocked client uses
[task-operation-encryption.ts](../cantrip_app/src/lib/task-operation-encryption.ts)
to allocate the operation ID, build the canonical running-round input, encrypt
it under `task-content`, create the encrypted Task user-message copy, and add
an HMAC-SHA-256 opaque fingerprint derived from a separate lookup-key domain.
The fingerprint binds the operation, protected state, and encrypted message,
making retries comparable without exposing or comparing Task prose. Fresh
encryption nonces mean a separately prepared operation need not produce
identical ciphertext.

Cantrip Server's [encrypted relay](../cantrip_server/src/tasks/encrypted-relay.ts)
adds only a generic operation label and the `task-encrypted` result mode to the
normal worker turn command. It can validate matching chat, operation,
classification, and fingerprint metadata, but it has no output schema,
plaintext prompt, structured result, component key, or Task crypto dependency.
The existing turn machinery is ready to use this relay without constructing a
continuation prompt from server-readable messages.

On the assigned worker,
[task-operation.ts](../cantrip_worker/src/task-operation.ts) obtains the exact
active `task-content` revision before model execution, authenticates and opens
the input, composes the planner or finalizer prompt, selects and validates the
structured output schema, builds the combined implementation objective, and
encrypts the completed round and Goal objective. Model text and Task-specific
stream events are suppressed from the server; the returned turn has an empty
visible body and only authenticated envelopes plus the minimum completed-state
classification. The same Goal command accepts that encrypted objective and
opens it only for its bound chat and worker thread.

Focused protocol, crypto, app, worker, and server-relay tests cover intended
recipient round trips, opaque fixtures with no sentinel prose, stable keyed
fingerprints, fresh ciphertext, missing or stale grants before model
execution, tampering, swapped operation metadata, worker-side structured
validation, and Goal thread binding. Production Task routes now use this
encrypted execution path and persist its opaque results as described below.

### Encrypted Task core persistence

[Migration 0103](../cantrip_server/drizzle/0103_foamy_wolf_cub.sql) deliberately
deletes only chats whose experience is `task`, allowing their dependent Task
records and planning rounds to cascade while preserving accounts, encryption
profiles, projects, workers, workspace data, and ordinary chats. It then
replaces the Task prose columns with public workflow classifications and one
bounded `task-content` envelope per Task or planning round. There is no legacy
plaintext compatibility mode because existing development Task data is
explicitly disposable for this rollout.

The trusted app adapter in
[task-persistence-encryption.ts](../cantrip_app/src/lib/task-persistence-encryption.ts)
allocates Task IDs, decrypts reads, validates questions and optimistic
revisions locally, and encrypts a complete replacement bundle for every draft,
plan, operation, retry, and failure transition. Before execution it also
prepares authenticated running and failure bundles. The server can therefore
persist or select a restart-safe failure state without learning the error text
or synthesizing protected prose.

The opaque repository in [tasks.ts](../cantrip_server/src/db/tasks.ts) stores
only envelopes and the minimum classifications needed for authorization,
routing, compare-and-set transitions, restart reconciliation, and idempotency.
Workers decrypt operation inputs, build prompts, validate model output, and
return both the encrypted round and complete next Task bundle. The server
initially retained generic Task chat placeholders; migration 0104 and the
secondary-copy closure below replace them with authenticated encrypted
messages. The server does not import `@cantrip/crypto` or receive a component
key.

Focused app, worker, relay, and temporary-PGlite tests cover encrypted create,
draft update, operation completion, retry idempotency, restart-safe failure
selection, locked-client rejection, worker-side encryption, and the migration's
Task-only destructive scope. These tests also use sentinel prose that never
appears in the app's outgoing payload.

### Encrypted Task secondary copies

[Migration 0104](../cantrip_server/drizzle/0104_short_mole_man.sql) repeats the
narrow pre-release reset for Task-experience chats, makes ordinary
`chat_messages.content` nullable, adds a bounded Task message envelope and
public attachment-ID list, and enforces that every message row has exactly one
of the visible or encrypted forms. It preserves accounts, projects, encryption
profiles, grants, and ordinary agent chats; no legacy Task-message reader or
plaintext fallback is provided.

The trusted [Task message adapter](../cantrip_app/src/lib/task-message-encryption.ts)
encrypts Task user messages before relay and decrypts authenticated Task
history, live events, and Goal objective snapshots in the client. The assigned
worker creates encrypted planner/finalizer and Goal-turn assistant messages,
encrypts Goal status responses, and opens Task relocation history only after it
has the active `task-content` grant. Restart and relocation therefore reuse the
worker's persistent private key and scoped server-held grant, not a password or
server-readable recovery key.

Cantrip Server stores and publishes only opaque Task message summaries. It
maintains message order, role, mode, attachment IDs, idempotency keys, model
routing, Task/Goal state, and optimistic revisions without constructing Task
prose. Goal dashboard and status routes relay encrypted objective snapshots;
PR association uses worktree and execution-lane branch metadata instead of
scanning assistant text. Task console/thread synchronization rejects plaintext
reconstruction, while relocation snapshots carry the encrypted transcript to
an authorized destination worker. Plain chat turns, queued prompts, project
automation prompts, and row-ID-changing forks are rejected for encrypted Task
chats until those features gain their own trusted-endpoint designs. Ordinary
agent chats retain their existing plaintext behavior.

Focused [client adapter](../cantrip_app/src/lib/task-message-encryption.test.ts),
[live-query](../cantrip_app/src/lib/app-live-query.test.ts),
[worker relay](../cantrip_worker/src/task-operation.test.ts),
[server persistence](../cantrip_server/test/task-domain.test.ts),
[dashboard](../cantrip_server/test/task-dashboard.test.ts), and
[relocation](../cantrip_server/test/chat-relocation-jobs.test.ts) tests cover
message and Goal round trips, row-ID binding, worker-only reconstruction,
missing grants, live delivery, opaque database records, ordinary-path
separation, PR association without message inspection, and the destructive
reset boundary.

### Task E2EE closure audit

The final closure removes the former server-side Task planner and finalizer,
their plaintext result parsers and compatibility tests, and the dashboard's
last message-text inference. Prompt construction and structured model-result
validation now exist only in the trusted
[worker Task operation](../cantrip_worker/src/task-operation.ts). The server's
[Task repository](../cantrip_server/src/db/tasks.ts),
[opaque relay](../cantrip_server/src/tasks/encrypted-relay.ts), routes, live
events, dashboard, and relocation paths operate only on public workflow state
and authenticated envelopes.

The static [server boundary audit](../scripts/audit-server-boundaries.mjs) now
walks every production server TypeScript source and fails on `@cantrip/crypto`,
Task decryption helpers, trusted app or worker Task adapters, plaintext Task
protocol types, or a missing opaque/rejection contract on a Task-adjacent
route. It also proves repository guards keep ordinary plaintext messages,
queued prompts, and project automations out of Task-experience chats. The
checked-in [route inventory](security/server-route-inventory.json) records
these dependency, route, and repository guarantees alongside the complete
server surface.

The focused
[Task lifecycle test](../cantrip_server/test/task-e2ee-lifecycle.test.ts)
drives an encrypted draft through initial planning, encrypted answers and
direction, continued planning, finalization, Goal creation, execution, and
completion with the real shared codecs and worker endpoint functions. It
checks stale and replayed writes, rejects ordinary plaintext message, queue,
and automation ingress, closes the server, reopens its temporary PGlite data
directory, and scans Task rows, planning rounds, messages, relocation copies,
queues, automations, and audit events for sentinel prose. The scan is zero.
Client and worker focused tests separately cover locked, missing, revoked,
stale, wrong-associated-data, tampered, and restart cases.

Together with the deliberately Task-only resets in
[migration 0103](../cantrip_server/drizzle/0103_foamy_wolf_cub.sql) and
[migration 0104](../cantrip_server/drizzle/0104_short_mole_man.sql), this
earns `E2EE complete` for Task content. There is no plaintext compatibility
fallback. Ordinary agent chats and their queued prompts remain plaintext and
planned; Task and chat titles are now separately E2EE complete.

## Credentials and provider configuration

Credentials are high-value but architecturally harder. Provider records
currently include base URLs, encrypted API keys, account identity, refresh
state, quota observations, and server-managed refresh leases.

True E2EE means the server stores an opaque credential envelope, an authorized
worker decrypts it when launching Codex, OAuth refresh occurs on a worker or
client, and updated tokens are re-encrypted before upload. The server retains
only provider kind, opaque account ID, health state, routing priority,
expiration time, and selected quota metadata. Provider testing and refresh are
unavailable while every authorized worker is offline.

## Projects, worktrees, and Git

Source contents already remain on workers. The server stores repository
identity, GitHub URL, local paths, worktree paths, branch and HEAD state,
conflicts, Git operation output, and replica jobs. The user-chosen project
display name is now encrypted independently of that operational repository
identity.

A reasonable split encrypts display names, repository URLs, absolute and
display paths, branch names, conflicted paths, Git output, errors, and status
snapshots. Opaque project, worker, and worktree IDs, replica and job state,
revision fingerprints, leases, and placement relationships remain plaintext.

## Analytics

Token usage and provider quota history are intentionally queryable by
provider, account, model, project, worker, chat, turn, and date. Fully
encrypting the numeric ledger removes server-side historical graphs, quotas,
and budget enforcement.

A balanced design keeps counters, timestamps, opaque dimension IDs, and
versions plaintext; encrypts raw provider payloads, labels, names, errors, and
potentially exact model names; and lets clients resolve opaque dimensions to
decrypted names. A later privacy mode can move the entire ledger to workers.

## Important web-client limitation

A cloud server can serve modified JavaScript that steals decryption keys.
Therefore E2EE strongly protects against database leaks, backups, operators
browsing rows, and passive server storage access, but protection against a
deliberately malicious server requires signed Tauri or Capacitor clients or a
separately hosted and pinned web client.

Metadata remains visible, including message timing and sizes, project and chat
counts, worker presence, model-route choices, and traffic patterns.

## Recommended rollout

1. **Envelope and key formats — complete:** versioned authenticated payload,
   password-wrapper, device-wrapper, and worker-grant formats plus shared
   endpoint primitives are implemented. Recovery registration remains part of
   client initialization.
2. **Opaque server key registry — complete:** public keys, independent password
   KDF metadata, wrapped keys, approval and revocation state, grant revisions,
   and migration state are persisted without server-side decryption.
3. **Client key custody — complete:** generate a nonextractable device key,
   persist it behind a replaceable local-store adapter, keep unwrapped key
   material in memory, and lock it on identity or server lifecycle changes.
4. **Client initialization and recovery — complete:** generate the Account
   Master Key, create the independent password or anonymous recovery wrapper,
   authorize client devices, unlock later sessions with the device key, and
   keep password changes on the same encryption root.
5. **Persistent worker grants — complete:** generate worker keypairs, authorize scoped
   component keys once, and prove workers can restart and decrypt their granted
   components without a client or password. Worker heartbeat status now reports
   whether its endpoint key is pending, ready, or unavailable and which scoped
   revisions are in memory.
6. **First narrow payload — complete:** workspace display names use row-bound
   authenticated encryption and blind uniqueness tags. Unlocked clients lazily
   migrate legacy plaintext with explicit remaining counts and revision checks;
   inactive deployed owners may therefore still have legacy rows.
7. **Task content — complete:** the Task vertical slice encrypts core rows,
   planning rounds, execution, Task-only message history, Goal objectives,
   live events, and relocation snapshots. Obsolete server plaintext builders
   and parsers are removed; static dependency, route, and repository audits
   enforce the trusted-endpoint boundary; and a reopened temporary-database
   scan contains zero Task sentinel prose. Ordinary chats, queued prompts, and
   general interaction payloads remain plaintext and planned; Task/chat titles
   are tracked separately and are now E2EE complete.
8. **Private display labels — complete:** one bounded bundle, exact
   associated-data mapping, trusted
   client and worker adapters, scoped worker readiness, and fail-closed label
   states cover projects, chats, surfaces, project views, and tab groups.
   Project display names now use opaque persistence after a deliberate
   project-domain reset. Ordinary chat and Task titles use opaque persistence,
   including archives, imports, forks, automations, execution targets, and tab
   members. Surface, project-view, and custom tab-group labels now use opaque
   persistence and client-only presentation as well.
9. **Surface private-state foundation — complete:** one independently scoped
   component now provides bounded terminal, Explorer, browser, Remote Desktop,
   and inventory bundles; persistent and ephemeral associated-data mappings;
   trusted client/worker adapters; scoped readiness; and restart-safe custody.
   Production persistence remains plaintext until the following surface
   cycles switch each domain.
10. **Attachments and relayed streams:** encrypt metadata and add
    application-layer encryption when bytes traverse relays.
11. **Secrets:** replace server-decryptable provider and MCP vault envelopes
    with client and worker decryptable envelopes.
12. **Remaining private metadata persistence:** switch terminal directory and
    service commands, Explorer selected paths, browser URLs, and Remote Desktop
    selection/inventory to the new component. Git output and policy bodies stay
    under their appropriate future components.
13. **Workflows and optional private analytics:** split scheduling metadata
    from encrypted definitions, inputs, and results, then minimize or relocate
    analytics according to the selected privacy mode.

A usable first encrypted component is moderate in scope. A robust system with
multi-device enrollment, unattended workers, recovery, rotation, migration,
encrypted search, sharing, and revocation is a substantial security project.
The strongest practical target is not “encrypt every column.” It is an opaque
server control plane with encrypted user payloads, where authorized clients and
workers are the only decryption principals.
