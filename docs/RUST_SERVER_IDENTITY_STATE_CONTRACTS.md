# Identity and desktop-update state contracts

Rust remains the default server. This milestone qualifies twelve current
repository identities and repairs model-operation usage attribution. Complete
replacement acceptance remains open. The base is
`348b161e52d0d3f6478640bc984e9f541f5fb66a`.

## Behavior

The retained baseline reproduces an accepted model-operation update that clears
old chat attribution in Node but retains it in Rust. Native persistence now
explicitly clears `provider_account_id`, `turn_id` and `reasoning_effort`, while
preserving immutable terminal receipts, dispatch identity, invalid-count rejection
and late-running suppression. The final case seeds all three attribution fields
and checks their removal on both peers.

CSRF rotation now returns the actual updated-row boolean and captures the two
write clocks separately, matching Source. Missing and revoked sessions remain
unchanged; an expired but unrevoked row remains eligible for this repository
operation. The public session handler still owns authentication policy. Mobile
grant cleanup receives the existing 24-hour cutoff captured by the public caller;
strict expiry boundaries and consumed grants retain their current behavior.

Worker-principal lookup and replacement cover owner/worker fences, revoked
principal lookup, opaque grant revocation and actual primary-key failure rollback.
Online-worker counts use the existing worker mapper and online-status filter.
Whitelist membership retains exact repository matching.

The three Source secret-migration aliases are intentionally empty. Their comments
incorrectly named migration 0119; the canonical existing cutover is
`0120_protected_provider_mcp_secrets.sql`. Rust already embeds that chain. The
fixture invokes the actual Source no-ops and actual native migration replay, then
checks that current protected API keys, signed-in account credentials and MCP rows
remain unchanged. This adds no migration, runtime deletion or legacy-secret reader.

## Executed local evidence

| Scope                                          | PGlite | Private PostgreSQL | External PostgreSQL | Total |
| ---------------------------------------------- | -----: | -----------------: | ------------------: | ----: |
| Paired repository cases                        |     44 |                 44 |                  44 |   132 |
| Paired HTTP observations, three auth modes     |    244 |                244 |                 244 |   732 |
| Paired real relation-failure responses         |     27 |                 27 |                  27 |    81 |
| Optimized authentication cases, eight profiles |    361 |                361 |                 361 | 1,083 |

Each repository run captures exact before/after SQL in nine domains, independently
checks write clocks and generated identities, and reopens both peers to verify
retained rows and clocks. Rejected operations, no-ops and migration replay require
unchanged state rather than merely equal return values.

The HTTP runs exercise the actual public session and mobile-grant callers plus
the nine desktop-update counts. They include running/approval/archived Chat states,
owner and lifecycle filters, all nine real missing-relation failures and recovery.
Password and account profiles force stored CSRF repair and inspect the grant hash,
creating session, two-minute expiry and asynchronous old-grant cleanup. All eighteen
debug server exits are clean. These are focused actual-HTTP tests with controlled
worker replies, not full worker/UI qualification.

The final optimized macOS arm64 executable separately repeats all three auth modes
with external PostgreSQL: 244 paired observations, 27 paired relation failures and
six clean exits. Both peers reject the SQL test HTTP route with 404. Direct database
clients supply transactional fixture setup and inspection.

The relocated `1.1.2794` native package passes all three stores, retained writes,
restart, migrations and export launchers with Node absent from the server PATH,
Homebrew reads denied and artifact writes denied. All 1,762 manifest files are
verified. The executable size and SHA-256, report hashes, method bindings and
historical failed attempts are recorded in
[the evidence summary](security/rust-server-identity-state-acceptance.json).

Local checks pass 86 Rust library tests, strict all-target Clippy, 278 script tests
with one Windows-conditional skip, native authority checks and the source-drift
comparison of sixteen schema graphs plus the endpoint-provider map. Broader
worker/app baseline failures retain their scope in
[Node retirement](RUST_SERVER_NODE_RETIREMENT.md). No hosted Actions are used.

## Coverage and remaining acceptance

The ledger now maps 331/370 repository identities, operation scopes on 110/135
tables, 523/584 routes, 117/323 worker commands and 29/47 Live resources. These are
evidence mappings, not completion percentages. There remain 39 unmapped repository
identities, 25 tables, 61 routes, 206 commands and 18 Live resources, plus historical
partial entries and complete original-goal acceptance.

Final supported-platform shipping artifacts and deployment-readiness reconciliation
remain separate. Existing migration/rollback and Windows/Linux qualifications retain
their original artifact scope. No production Winterhold deployment is performed.
Worker rewriting and shared crate extraction remain outside this server milestone.

Owned source, QA, available fixture databases and package are retained in the
`rust-server-identity-state-delivery-20261110-v1` evidence archive and independently
verified before owned cleanup. The PGlite authentication report survives, but its
temporary database root was removed by the earlier harness cleanup behavior.
