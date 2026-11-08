# Native project lifecycle and preferences

Rust now implements project removal, preferred-worker selection, worktree-policy
updates and complete project ordering. Node remains the default server and the
full replacement is incomplete. The actual production inventory probe now has
29 active generic-404 differences, down from 33 before this milestone.

## Behavior

The four endpoints retain Source parsing, validation, capability-pre-handler
precedence, ownership, error responses and response-completion Live publication:

- `DELETE /api/projects/:projectId`
- `PATCH /api/projects/:projectId/preferred-worker`
- `PATCH /api/projects/:projectId/worktree-policy`
- `PATCH /api/projects/order`

Preference responses use the actual updated row and current replica summaries.
Local Git preference selection requires a ready source. JavaScript string
identity is retained until the SQL boundary: a lone surrogate cannot alias an
owned project in an ordering request or a ready local Git replica. Reordering
requires the complete owned set, uses one transaction, and retains timestamps.

Explicit deletion preserves Source's failure boundaries and sequence. It checks
setup, replica jobs and conversions; revokes managed shares and terminal leases;
then stops Run runtimes and performs ownership-aware cleanup. Attached user
folders reject file deletion. Owned and converted managed folders use their
worker's safe deletion command; ordinary Cantrip replicas use source deletion,
while user-owned replicas retain their files. File deletion awaits all terminal
closures. Preserving files starts connected terminal closures without awaiting
their replies. Remote-surface closure errors are ignored. Database removal
retains the existing separate project-delete and mobile-configuration-update
statements; this flow does not acquire a new atomic rollback guarantee.

Static project paths retain method-specific dynamic deletion, including real
project IDs `order`, `from-folder` and `from-github`. Rate keys and persisted audit
attribution retain Source's dynamic identity or unmatched raw path as appropriate.

Worktree-policy SQL triggers advance Chat computer-use generations. The native
database observer now delivers their post-commit preview revocations, including
changes written by another database client. It validates the exact Source
notification schema, bounds/coalesces pending scopes, uses the existing owned
worker command bus, checks close acknowledgments and drains during shutdown.
The durable SQL generation is the authorization fence; notification delivery
retains Source's best-effort diagnostics. This does not implement the remaining
computer-use operation/preview HTTP endpoints.

## Executed local acceptance

On macOS ARM64, all nine PGlite/bundled-PostgreSQL/external-PostgreSQL and
none/password/accounts combinations pass 65 paired lifecycle cases. The retained
results contain 1,224 HTTP observations and compare full response contracts,
durable before/after state, cleanup commands, project Live events and audit
attribution. All 18 servers exited zero. Actual SQL-trigger failures prove
ordering rollback. Queued/running replica jobs block deletion; blocked replica
jobs permit it, while queued/running/blocked conversions all block it.

Additional account-profile comparisons pass on all three stores. Malformed
authority notifications do not dispatch worker commands. Held terminal replies
prove that preserving-files responses can complete before terminal acknowledgments.
Actual HTTP caller cancellation during destructive cleanup retains admitted
work and completes deletion; neither peer publishes a completed-response project
event or audit for that canceled response. The original worker commands, database
states, Live frames and audits are retained for comparison.

The existing encrypted browser SDK and unchanged full worker pass 132 product
steps across six Node/Rust storage cells. Twelve real long-lived Run children
receive termination while their directory still exists, before project cleanup.
Managed bytes are preserved or removed according to the requested mode; actual
attached user bytes remain intact. Production server/worker restart retains the
result. All 24 production server and 30 full-worker processes exit zero.
Only a disposable local Git checkout's catalog classification is seeded to
exercise GitHub-only policy selection; no GitHub operation is simulated or
directed at a user repository. The packaged Codex 0.166.0 executable passes
artifact/source/patch hashes, executable version and protocol-extension checks.

Native executable SHA-256:
`133998085486c24ffcc1994cc57c3592bc99dc0b692ad700e2eb7354d8357155`.
The full 584-route probe completes both peers with clean exits and exactly 29
remaining active fallbacks. Its nonzero status records the unfinished replacement.

All 64 Rust library tests, strict all-target Clippy, current generated contracts,
server-boundary and release-only workflow audits pass locally. The focused app
worktree/removal suites pass 57 tests. The broader checks are not green:

- Protocol: four failures / 1,116 passing tests, including compiled/source
  copies of stale export-count and discriminator-order assertions.
- Focused Node server worktree suites: one failure / 59 passing tests;
  the standalone Chat fixture expects `started` but receives `queued`.
- Focused worker worktree/app-server suites: two failures / 91 passing
  assertions, plus two unhandled errors in capacity-retry tests.
- `pnpm check` stops at unchanged source limits: `build-app.ts` 1,532/1,500 and
  `chat-turn-runtime.ts` 2,336/1,999. Downstream aggregate stages did not run.

Every focused TypeScript failure is freshly reproduced on a separate, unmodified
Git export of baseline `b5ba3a2fb4f4b1c0f0d58693c4beb7a052d07d67` with its own
offline installation and package builds. The failures and initial fixture/native
regressions remain retained separately; no assertions were weakened to pass them.

## Reproduction

Build current workspace packages and the Node reference, then run
`project-administration-http-compatibility.mjs` with `node --import tsx`.
It accepts `--database pglite|bundled-postgres|postgres`, optional `--profile`,
`--runtime`, `--boundaries`, and `--report`. `CANTRIP_RUST_SERVER_BINARY` supplies
the development-only `http-sql-fixture` executable. That fixture uses the real
production router and lifecycle with isolated SQL setup on the same open database.

Run `actual-folder-client.mjs --project-administration --database <mode> --report
<path>` for actual browser/full-worker/Run/filesystem acceptance. Supply the
production executable through `CANTRIP_TEST_SERVER_BINARY`, the full current
worker through `CANTRIP_TEST_WORKER_PACKAGE`, and current CLI/Codex binaries using
the existing test environment inputs. An optional
`CANTRIP_TEST_PROJECT_REPOSITORY_BINARY` avoids rebuilding the disposable offline
catalog fixture. Complete process logs and actual child exit statuses are retained.

These results do not establish other supported platforms, final packaged-update
acceptance, complete-domain/background-service parity, performance acceptance,
Rust default selection or production Node removal. All validation runs locally;
GitHub Actions remains reserved for releases and deployments.
