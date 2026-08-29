# Portable provider authentication

- Status: endpoint-encrypted for static API keys and ChatGPT/Grok OAuth
- Last updated: 2026-08-29
- Codex boundary: packaged `codex-cli 0.151.0`
- Related: [encryption](ENCRYPTION.md),
  [runtime compatibility](CODEX_RUNTIME_COMPATIBILITY.md), and
  [multi-worker placement](MULTI_WORKER_ARCHITECTURE.md)

## Security outcome

Provider secrets are protected by account encryption keys that the server
cannot unwrap. A PostgreSQL dump, server-side envelope keyring, or copied row is
not sufficient to recover a static API key, OAuth access token, refresh token,
or ID token. The authorized app and workers are the only decryption endpoints.

The user has one password. Login derives the independent authentication value
used by the server and a password key-encryption key used by the app to unwrap
the random account master key. The encryption key is not derived from the
server's password verifier. There is no recovery secret, local encryption
password, or second password for the user to retain.

Workers have app-managed public/private encryption identities. The unlocked app
wraps scoped component keys to approved worker public keys. The server stores
the public keys and opaque grants, but cannot unwrap them. An authorized worker
persists its private identity so it can run unattended after approval without
asking the user or app for the password again. Revoking the worker principal or
its grants removes future Cantrip authorization.

| Data or action                                                                                    | App                                                           | Server                                              | Authorized worker                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Static provider API key                                                                           | Encrypts on create/update; decrypts only for explicit app use | Stores an opaque `protectedApiKey` envelope         | Decrypts only while constructing a provider runtime                               |
| OAuth access, refresh, and ID tokens                                                              | Never stores or displays                                      | Stores one opaque account-bound envelope            | Obtains through OAuth, encrypts, decrypts for runtime use, refreshes, and reseals |
| OAuth subject identity                                                                            | Never receives                                                | Stores and enforces only a keyed blind index        | Computes the blind index and sees identity while authenticating or refreshing     |
| Provider name, kind, URL, account label, auth state, expiry, coarse quota/plan data, and catalogs | Displays and mutates                                          | Retains as documented routing/presentation metadata | Uses the minimum runtime subset                                                   |
| OAuth email and detailed plan/identity claims                                                     | Never stores or displays                                      | Does not persist                                    | Keeps inside the protected credential bundle                                      |

## Protected credential contexts

Static API keys use component `provider-credential` and bind authenticated
encryption to the owner, provider row, field, and key revision. OAuth bundles
use component `provider-credential` and bind to the owner, provider row,
provider-account row, field, and key revision. Moving ciphertext between rows,
owners, or components fails AES-256-GCM authentication.

An OAuth envelope contains the complete provider-specific credential bundle.
The server receives only the protected envelope, a keyed subject blind index,
an optimistic revision, and bounded expiry metadata. The server cannot
exchange or refresh the credential itself.

## OAuth capture and refresh flow

```mermaid
sequenceDiagram
    participant A as "Unlocked app"
    participant S as "Cantrip server"
    participant W as "Authorized worker"
    participant P as "Provider OAuth"

    A->>S: "Approve worker and upload wrapped provider-credential key"
    S-->>W: "Opaque component-key grant"
    W->>W: "Unwrap grant with persisted worker private key"
    W->>P: "Run ChatGPT or Grok OAuth"
    P-->>W: "Access/refresh credential"
    W->>W: "Encrypt row-bound bundle and derive subject blind index"
    W->>S: "Opaque envelope + blind index + public metadata"
    S->>S: "Persist ciphertext and advance revision"
    W->>S: "Later: fetch opaque credential by provider/account ID"
    S-->>W: "Opaque envelope + revision"
    W->>W: "Decrypt; refresh provider-side if needed"
    W->>S: "Resealed replacement + expected revision"
```

The internal credential GET and PUT routes require an individually enrolled
worker credential and an active `provider-credential` grant. The credential
fixes the owner and immutable worker ID; route parameters cannot select another
owner's account. The server uses optimistic revisions to reject stale refresh
writes and a keyed subject blind index to reject an identity change.

The worker keeps decrypted tokens only in memory for runtime use. ChatGPT is
injected into the supported Codex authentication interface without creating a
normal server-owned credential. Grok uses its worker-local loopback adapter.
Refresh runs on the authorized worker, and a successful replacement bundle is
encrypted before upload. Secret values and complete OAuth responses must never
be added to application events, logs, or diagnostics.

## Static API keys and provider catalogs

The app allocates the provider UUID before encryption so the API-key envelope
is bound to its final row. Provider create/update requests contain ciphertext,
never an `apiKey` field. A worker opens that envelope immediately before
creating its internal runtime provider and does not persist the plaintext.

Server-side catalog discovery uses only public, anonymous endpoints. In
particular, the OpenRouter server catalog requests `/models` without an
authorization header; it does not fetch the private `/models/user` catalog.
Actual access is enforced when the authorized worker invokes the provider with
the decrypted key.

## ChatGPT through Codex 0.151

Portable ChatGPT requires Codex 0.151.x, experimental API negotiation, and the
`account/login/start` method. The worker opens the account-bound envelope,
injects the access token, ChatGPT workspace ID, and plan type into Codex, and
keeps only the short-lived usable view in memory.

When Codex sends `account/chatgptAuthTokens/refresh`, the worker validates the
request, refreshes the protected credential provider-side, reseals it with an
expected revision, verifies the account and upstream workspace are unchanged,
and returns the new access token. Unsupported Codex versions or capabilities
fail before the portable runtime starts. Normal operation does not retain an
`auth.json` credential.

This interface is experimental in Codex 0.151. Cantrip does not patch it, but a
future Codex release may change its method names, payloads, result type, or
timeout. Do not widen the pinned range until the login and refresh fixture in
the runtime compatibility procedure passes against the new source.

## Grok/SuperGrok through the local proxy

The existing xAI subscription adapter remains worker-local because Codex must
talk to a Responses-compatible endpoint on the machine running it. Its token
source is the authorized worker's opened credential rather than a durable
`grok-auth.json` file.

The adapter preserves the provider-specific authentication headers, forwards
only to the configured xAI subscription origin, binds its randomized endpoint
to `127.0.0.1`, rejects paths outside its private `/v1` prefix, strips incoming
credential headers, limits request bodies to 64 MiB, and performs at most one
forced-refresh retry after an upstream 401. Model discovery and turns use the
same in-memory access path. Normal portable operation does not retain a
`grok-auth.json` credential.

## Relocation and lifecycle

Chat and Task worker grants include `provider-credential`, so an approved
target worker can reconstruct the same logical provider runtime after placement
or relocation. No credential home, plaintext token, or private worker key is
transferred between workers.

Signing out clears the opaque account credential, advances its revision,
invalidates Cantrip catalog/auth state, and commands connected workers to close
matching runtimes and remove captured local files. Because the server cannot
decrypt the OAuth bundle, it cannot perform provider-side revocation. Use the
provider's own security controls when upstream token revocation is required.

Migration `0120_protected_provider_mcp_secrets.sql` is intentionally
destructive for pre-release data: existing OAuth credentials are signed out,
old server-vault/plaintext credential columns are dropped, and users sign in
again through an authorized worker. Static provider keys and MCP definitions
must be recreated. No production or remote database reset is part of the
migration.

## Threat model and operating rules

| Threat                                | Control and remaining exposure                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database or server keyring compromise | Provider ciphertext still requires an account component key held by an unlocked app or approved worker. Retained routing, expiry, health, and coarse quota metadata remains visible. |
| Cross-owner request                   | Session or worker credential determines the owner; repository queries bind provider and account through it.                                                                          |
| Ciphertext moved to another row       | Authenticated context includes owner, component, table, row, field, and revision.                                                                                                    |
| Concurrent refresh                    | Expected revisions reject stale reseals; the worker refetches before retrying.                                                                                                       |
| Compromised approved worker           | It can use the provider components granted to it. Revoke that worker and revoke upstream provider sessions when compromise is suspected.                                             |
| Live endpoint compromise              | An unlocked app or authorized worker necessarily sees plaintext while using it. Keep plaintext lifetimes short and logs redacted.                                                    |
| Password change                       | The account master key is rewrapped with the new password-derived key; provider rows do not need re-encryption. Approved worker grants remain independently wrapped.                 |

## Focused regression evidence

The focused tests cover protected-secret authenticated context, app-side static
API-key sealing, worker-side API-key/OAuth opening and resealing, opaque server
persistence, revision and identity conflicts, worker authorization, and public
catalog behavior. The generated server-boundary inventory also rejects legacy
provider/MCP secret columns, plaintext request fields, and the former
server-side access-lease route.

Use targeted package tests plus the normal package typechecks. Platform OAuth
smoke tests remain manual QA: sign in once, complete ChatGPT and Grok turns,
restart an approved worker, exercise a refresh, relocate a chat, and confirm
that neither server storage nor logs contain the test tokens.
