# Production Node server retirement

The production `@cantrip/server` workspace and its build, development, start and
migration commands are removed. Normal service builds, desktop launch and
deployment use `cantrip_server_rs`. The unchanged worker still uses Node.
`cantrip_server/drizzle` retains the existing SQL migration chain, which Rust
embeds and applies without loading JavaScript.

## Development compatibility baseline

The former implementation and its behavioral assertions live in
`tests/reference-node-server`, with origin
`f9a9eb6f7c136f2f5ddae0eee89343dffe5fe762`. Repository-relative imports, module
asset URLs, test mocks, worker test fixtures and the SQL migration location
follow their current paths. The SQL files themselves are unchanged. The package has only
`reference:build`, `reference:test` and `reference:typecheck`; its dependencies
are development dependencies. It has no normal build, start, development or
migration command. Recursive production build/test/typecheck commands do not
select its reference scripts.

Use `pnpm server:reference:build` or `pnpm server:reference:test` explicitly for
legacy comparisons. Existing comparison assertions remain in place, including
historical profile and data-preserving rollback tests. This reference is not
included in the native server, desktop runtime, worker artifact or deployment
image. The separate bounded profile converter uses the legacy PGlite SDK; it
does not import this retired server.

## Current verification authority

The standard typecheck and test commands now also check the Rust service and
run its library tests. Application and repository decomposition checks inspect
the current Rust sources. Network and installation compatibility checks inspect
the current Rust routes, metrics, configuration, database location and server
identity producer. Workflow and Run-removal audits include Rust source.

The previous TypeScript classification assertions remain in
`audit-reference-server-boundaries.mjs`. They are compatibility evidence about
the retained baseline and shared contracts. The normal server-boundary audit
also executes the current native authentication/restart, encryption registry
and real HTTP authority tests. A passing reference audit alone does not
establish Rust security behavior.

The HTTP test binds the production Rust router and independently checks:

- Authentication and untrusted-origin rejection.
- CSRF enforcement and unchanged opaque grant bytes.
- Separate account profiles and inaccessible foreign grants.
- The existing indistinguishable conflict response for foreign, missing or
  changed principal mutations, while the original grant stays unchanged.
- Logout's existing 204 response, session revocation and the other session's
  continued access.
- Actual legacy endpoint deprecation headers and request accounting.

These are scoped native checks, not a claim of complete product or platform
acceptance. The retained broader compatibility, migration, recovery, encrypted
client, performance and deployment matrices retain their separate scope.

## Qualification and remaining delivery

The owned milestone reports are under `.qa/rust-node-retirement`. The reference
TypeScript build, 55 focused source/compatibility tests, native source budgets,
network checks, removal audits, seven installation contract/recovery simulations
and the native HTTP authority test pass locally.

The production-isolation driver temporarily makes both reference `src` and
`dist` unavailable, executes unflagged `pnpm package:server`, then exercises all
three storage modes using the resulting distribution with Node absent from the
server's runtime PATH. It restores the reference in its finalizer. Its initial
attempt was interrupted during compilation, produced no completion report and
is not counted as passing; the resumed run has a separate report.

The resumed working-tree candidate `1.1.2785` passes that complete isolation
run: all three stores, local/hosted reopening, migrations, SQL exports, retained
identity/settings and restart, SIGTERM, configuration precedence and embedded
runtime fallback. All 1,762 artifact hashes are verified; Node is absent from
the server's PATH, Homebrew reads and artifact writes are denied, and both
reference source and compiled JavaScript stay unavailable throughout the build
and runtime checks. The driver then restores the development reference.

The current Rust library suite passes all 85 tests. The remaining computer-use
server stage passes 246 tests with three existing conditional skips, and its app
stage passes 322 tests. The 20 app suites that initially lacked built NBT/UI
workspace dependencies pass all 167 tests after those packages are built. The
shared package and site tests also pass. Computer-use test stages now use two
workers, and formatting excludes generated Cargo targets for every crate.

The whole-repository check is not reported as passing. The bounded worker suite
finishes with 2,930 passes, 269 skips and 20 failures. Nineteen failures reproduce
in the clean Primary checkout: model-capacity/retry, provider discovery and
portability, queue acknowledgement and execution-observation/permission fixtures.
The remaining filesystem-watcher failure passes separately with all 11 worktree
tests, without assertion/deadline changes. Five app Live-query/Explorer assertions
also reproduce on Primary.
The repository-wide formatting check reports the same 12 unchanged files on
Primary; every changed supported file passes formatting and native Rust formatting
passes. Failed and interrupted attempts, exact commands and baseline comparisons
are retained alongside the passing results. These baseline failures do not
establish shipping acceptance and remain visible for the final audit.

Final supported shipping and existing-client encrypted desktop/update acceptance
remain required by the full replacement goal. The worker rewrite and extraction
of further shared crates are later work. Development validation runs locally;
no hosted development Actions or production Winterhold deployment is performed.
