# Existing-client encrypted desktop acceptance

The normal macOS desktop build `1.1.2786`, from integrated source
`384e537d01bcc4d81d963916b087aafbeea412a9`, passes all three existing-profile
upgrade and restart cases with the Rust server. Its actual release WebView
finishes encryption preparation, the packaged worker connects, and the original
server, worker and client-key identities survive. This closes the previously
recorded macOS Keychain-dependent acceptance gap. The older blocked attempt is
historical and is not counted as passing.

## Artifact and execution

The dedicated application is `Cantrip Server Shipping QA.app`, with identifier
`art.cantrip.rust-qa-recovery`. It uses the existing QA installation catalog and
OS key store. The normal frontend/Tauri build and default Rust desktop-runtime
packaging are used; the QA overrides select only the separate application name,
identifier, ad-hoc signing and disabled updater-artifact generation. No production
release, notarization or Winterhold deployment is performed.

The server is built by unflagged `pnpm package:server`. Worker JavaScript and its
workspace packages are freshly built and deployed. The nine verified native
worker assets are reused: their source crates and Codex patches have no changes
since their earlier qualification. `pnpm package:desktop-runtime --from-artifacts`
assembles the server, worker and bounded profile converter without rebuilding
the unchanged native worker. Existing build caches are reused with two Cargo
jobs and incremental compilation disabled.

The retained application executable has SHA-256
`76d1524596f1d1161f37e66210602fe399be0b80f1f8037872eedd0eea368a0c`.
Its bundled native server has SHA-256
`c3c69893735427df0eef1ea9379fafe3540a59f363aef3529c54b833ca84a864`.

## Existing data and assertions

Original fixtures are copied into independent writable files with APFS clone
support; database files are not hardlinked. The actual old packaged Node server
first reopens each copy and verifies its identity and light theme:

| Storage mode        | Retained server identity               |
| ------------------- | -------------------------------------- |
| PGlite              | `b02eba80-d335-40e6-a5a5-128c8bc9653f` |
| Bundled PostgreSQL  | `11922e6f-3b38-4970-bc6f-bd000e94aef3` |
| External PostgreSQL | `3fe9b7cc-5955-4849-8572-049af7cd64a4` |

The current application then upgrades and opens every store. Before writing,
the driver verifies the old identity and theme. It writes dark, observes the
real packaged worker and executes its version command. A second application
launch verifies retained dark state before writing light. Worker identities
are identical across both runs in each mode.

For every launch, the driver requires the existing
`session.refresh.completed/authenticated` renderer record. In
`application-session.tsx`, this state is returned only when
`prepareClientEncryption` returns `ready`; locked, recovery-required and failed
states do not satisfy the assertion. Each application exits with SIGTERM status
zero and leaves no owned server or worker child alive. A seventh case sends
SIGTERM during early PGlite startup and also verifies clean ownership shutdown.

The read-only `desktop-client-continuity.mjs` verifier independently compares
catalog snapshots. The installation, device public-key record, key alias and
provider, all four account bindings, principal IDs, grant/master-key revisions
and migration records are retained exactly. Only binding timestamps and the
normal catalog revision change. The verifier retrieves no private key and
modifies neither the catalog nor Keychain. Its regression cases reject replaced
identities, public keys, principals, key aliases, key revisions and lost bindings.
The application catalog, identities, vault and Keychain ACL are never reset.

## Other checks and scope

All eight continuity tests and the complete root script suite pass locally:
303 passes and 11 existing conditional skips. A fresh production route probe
completes all 584 inventory entries against both peers with zero native generic
fallback differences and two clean server exits. All 16 embedded protocol graphs
match the rebuilt TypeScript protocol. Route presence and schema equality retain
their limited scope; they do not replace domain, fault or migration results.

The source-history audit now reads both the original Node source location and
its relocated test-reference location. The current inventory contains 135
exported durable tables; the ledger's stale 136-table count is corrected.

The default history audit finds 48 Node-source commits, 44 with Rust-core edits.
The four remaining candidates are inspected separately: the reference relocation,
a facade-only TypeScript option declaration, Task interruption's explicit IDE
default (already supplied by native envelope parsing), and Drizzle timestamp
parameter encoding (native telemetry already binds ISO strings). Source pairing
alone is not treated as behavioral acceptance.

The owned reports, immutable application copy, client catalog snapshots and
reproduction drivers are under `.qa/rust-shipping`. Final whole-replacement
coverage and supported-platform reconciliation remain separate. The reproduced
baseline repository test/format failures recorded during Node retirement remain
explicit; this qualification does not describe the entire repository check as
passing. The worker remains Node, and development validation runs locally.
