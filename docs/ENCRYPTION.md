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

The central schema currently contains 76 durable tables covering identity,
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

| Data class                                                                       | Current protection                            | Rollout status             | E2EE feasibility     | Complexity  | What the server loses                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------- | -------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| Encryption key hierarchy and device grants                                       | No E2EE hierarchy                             | Planned foundation         | Required             | High        | Password-based server recovery and direct inspection of key material                           |
| Workspace display names                                                          | Plaintext                                     | Recommended first payload  | Very good            | Low-Medium  | Name-based server search and validation                                                        |
| Chat message bodies, reasoning, command output, diffs, file paths                | Plaintext                                     | Planned                    | Excellent            | High        | Full-text search, previews, content notifications, server-side summarization                   |
| Task briefs, plans, answers, goals, queued prompts                               | Plaintext                                     | Planned                    | Excellent            | Medium-High | Server cannot inspect or transform task content                                                |
| Attachment bytes, filenames, MIME, previews                                      | Bytes are worker-local; metadata is plaintext | Planned                    | Excellent            | Medium      | Server-side previews, malware scanning, content deduplication                                  |
| Interaction and approval request details and responses                           | Plaintext                                     | Planned                    | Excellent            | Medium      | Server can route approvals but cannot display or validate their semantics                      |
| Browser URLs, terminal titles and paths, Explorer paths, remote-window selection | Plaintext                                     | Planned                    | Excellent            | Medium      | Server cannot search or diagnose surface contents                                              |
| Tab titles and project display names                                             | Plaintext                                     | Planned                    | Very good            | Medium      | Server can retain ordering but loses name-based search                                         |
| Policies and agent instructions                                                  | Plaintext                                     | Planned                    | Very good            | Medium-High | Server cannot compose prompts; the worker must do it                                           |
| Provider API keys, ChatGPT/Grok credentials, MCP secret headers and environment  | Server-decryptable AES-256-GCM                | Planned replacement        | Very good            | High        | Credential refresh, provider testing, and catalog discovery must move to a worker or client    |
| MCP commands, URLs, and nonsecret configuration                                  | Plaintext                                     | Planned                    | Good                 | High        | Server cannot validate or describe configuration if fully encrypted                            |
| Workflow prompts, definitions, structured inputs, and results                    | Plaintext                                     | Planned                    | Good when split      | Very high   | Scheduler can route opaque jobs, but conditions and content evaluation must happen on a worker |
| Project and repository names, remotes, paths, branch names, and Git output       | Plaintext                                     | Planned partial encryption | Partial              | High        | Server orchestration currently depends on some of this data                                    |
| Token usage, quotas, and model-behavior analytics                                | Plaintext/queryable                           | Planned minimization       | Partial              | Medium-High | Fully encrypting numbers removes server dashboards, budgets, and historical analysis           |
| Diagnostic logs and audit metadata                                               | Redacted but server-readable                  | Planned minimization       | Partial              | Medium      | Fully encrypted logs prevent server-side operations and security investigation                 |
| Worker platform, capabilities, online state, and tunnel endpoints                | Plaintext                                     | Intentionally plaintext    | Poor                 | High        | The server cannot route sessions or decide which worker supports a feature                     |
| Workflow status, leases, retries, dependencies, and deadlines                    | Plaintext                                     | Intentionally plaintext    | Poor                 | Very high   | The server cannot schedule or recover jobs                                                     |
| User IDs, roles, account status, licenses, and memberships                       | Plaintext                                     | Do not encrypt             | Do not encrypt       | -           | The server must enforce authorization                                                          |
| Sessions, enrollment codes, and worker credentials                               | Hashed                                        | Keep hashed                | Do not encrypt; hash | -           | The server must validate them                                                                  |
| Opaque IDs, foreign-key relationships, ordering, and timestamps                  | Plaintext                                     | Usually keep plaintext     | Usually plaintext    | -           | Needed for synchronization and routing                                                         |
| Public provider model catalogs and system state                                  | Plaintext/public                              | No encryption benefit      | No benefit           | -           | Generally public or operational data                                                           |

The rollout status must be updated as each component lands. A row is not
`E2EE complete` while any normal write path stores plaintext or while legacy
plaintext remains without an explicit migration state.

## Chats and tasks

Chats remain the strongest high-value E2EE candidate after the foundation and
first narrow payload prove the system. Message content is concentrated in
`chat_messages.content`, while routing and ordering are separate fields such as
chat ID, sequence, role, worktree, model route, and timestamp. Tasks similarly
separate state from sensitive prose, but briefs, plans, questions, answers,
directions, and goal prompts are currently plaintext.

The server can retain chat ID, project ID, message sequence, role, timestamp,
running state, worker and worktree placement, model-route identifiers,
ciphertext, and encryption version. An authorized worker can decrypt the
component key at startup, build context and local indexes, compact or fork a
conversation, and upload new ciphertext without asking the client for the
password.

The main behavioral change is that search, compaction, and other content-aware
operations require an online authorized endpoint. The server can no longer do
them independently.

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
conflicts, Git operation output, and replica jobs.

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

1. **Envelope and key formats:** define versioned authenticated payload,
   password-wrapper, device-wrapper, worker-grant, and recovery formats.
2. **Opaque server key registry:** persist public keys, password KDF metadata,
   wrapped keys, grant revisions, and revocations without adding server-side
   decryption.
3. **Client initialization and recovery:** generate the Account Master Key,
   create the independent password wrapper, authorize client devices, and
   define password-change, reset, and recovery behavior.
4. **Persistent worker grants:** generate worker keypairs, authorize scoped
   component keys once, and prove workers can restart and decrypt their granted
   components without a client or password.
5. **First narrow payload:** encrypt workspace display names, migrate legacy
   plaintext on an unlocked client, and update the rollout ledger with evidence.
6. **Chats and tasks:** encrypt message content, task prose, queued prompts,
   interaction payloads, and relocation snapshots.
7. **Attachments and relayed streams:** encrypt metadata and add
   application-layer encryption when bytes traverse relays.
8. **Secrets:** replace server-decryptable provider and MCP vault envelopes
   with client and worker decryptable envelopes.
9. **Private metadata:** encrypt tab titles, browser URLs, project names,
   paths, Git output, and policy bodies.
10. **Workflows and optional private analytics:** split scheduling metadata
    from encrypted definitions, inputs, and results, then minimize or relocate
    analytics according to the selected privacy mode.

A usable first encrypted component is moderate in scope. A robust system with
multi-device enrollment, unattended workers, recovery, rotation, migration,
encrypted search, sharing, and revocation is a substantial security project.
The strongest practical target is not “encrypt every column.” It is an opaque
server control plane with encrypted user payloads, where authorized clients and
workers are the only decryption principals.
