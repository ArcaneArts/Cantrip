# Current wire protocol reconciliation

The full replacement remains incomplete and Node remains the default server.
This milestone restores broad wire comparisons after additive protocol changes.
It does not establish complete product, platform or deployment acceptance.

## Current source coverage

The initial audit found 65 missing fixture sets among 803 embedded security
roots and 15 missing examples among 323 outgoing worker commands. All 308
existing command examples still parsed the current TypeScript protocol.

Every current root now has a nonempty baseline fixture set. All 2,702 baseline
examples parse the actual `sourceContractSchema` authority. New fixtures reuse
the focused Chat import, Task input, suspension, Goal recovery, CantripOS and
worker ingress examples. Additional examples cover model operations and usage,
catalog pages, relocation, private Goal handoff captures and frame headers.
They contain synthetic content and operational identities only.

Valid Task baseline examples and deliberately invalid physical-source examples
are separate. The broad oracle includes the latter as rejection cases; the
focused Task oracle retains its original assertions. Its complete output and
all eleven focused Chat import oracles are byte-identical to the original
versions when run against the same current protocol.

All 323 command examples parse complete current worker requests. Every original
308 command example and 1,180 alternative case is retained exactly. The refreshed
alternative corpus contains 1,292 full requests and covers 562 options across
63 union schemas plus 733 values across 189 enum schemas. Union coverage still
requires the chosen option and the full enclosing request to parse. Enum cases
retain the existing ability to exercise an enclosing semantic rejection; the
actual TypeScript verdict supplies the expectation.

The two refresh utilities preserve examples and rebuild their coverage mapping
from the actual schemas. Both are idempotent. Missing domain examples fail the
development refresh rather than being replaced with generic placeholders.

## Historical public surface

The existing source tests failed on an export count and a command position.
Comparison with the historical source baseline identifies 76 additive runtime
exports outside the already reviewed groups. They are now listed explicitly,
along with seven additional model/Goal command discriminators. All legacy export,
command, event and notification fingerprints and counts remain unchanged.
The seven public-surface tests and all 298 tests under `src` pass locally.
After rebuilding, the complete package suite passes 1,120 test executions across
116 files, including compiled test copies. Protocol typechecking also passes.

## Native qualification

The focused Task-input comparison passes 8,222 actual TypeScript/Rust
value, issue and error-message cases. The complete broad native suite passes
893,386 comparisons across 802 roots; the outgoing request root is covered by
its separate streaming command suite. All 69,648 ECMAScript JSON round trips
also pass, including UTF-16, number serialization and property ordering.

The command suite passes all 323 examples, 86 boundary cases and 262,471
mutations. The actual mutation producer executes all 102 registered custom
checks. Exact parsed values, issues and validation error messages are compared.

After that run, five fixture sets were strengthened with populated endpoint and
Ollama pages, granted Goal captures and complete restoration/terminal metadata.
The existing streaming native parser fixture passes all 13,710 comparisons for
those five current sets. These overlap the earlier corpus and are not an
additional disjoint total. Per-root fixture hashes confirm the other sets did
not change. No production Rust parser change was necessary.

The read-only source audit confirms all sixteen embedded graphs/provider maps
still match the rebuilt protocol. No production protocol or generated graph
change was needed to restore these fixture sets.

```sh
pnpm --filter @cantrip/protocol build
node scripts/server-rust/refresh-worker-command-fixtures.mjs
node scripts/server-rust/refresh-worker-command-alternatives.mjs
node scripts/server-rust/cargo.mjs test \
  --test wire_contracts --test worker_command_contracts \
  --test task_input_contracts -- --nocapture
```

The bounded streaming runner can also compare selected roots, or the complete
broad corpus when `--schemas` is omitted:

```sh
node scripts/server-rust/cargo.mjs build --example wire-contract-fixture
node scripts/server-rust/wire-stream-compatibility.mjs \
  --executable /absolute/path/to/wire-contract-fixture \
  --schemas modelCatalogPageSchema \
  --report /absolute/path/to/wire-report.json
```

This qualification ran on macOS arm64. Product flows, supported shipping
artifacts and platforms, historical upgrades, post-write rollback, performance
and final default cutover retain their separate acceptance requirements.

Development validation is local. GitHub Actions remains reserved for releases
and deployments. `pnpm check` stops at the same Node decomposition budgets
reproduced on clean Primary: `build-app.ts` has 1,539 lines against 1,500 and
`chat-turn-runtime.ts` has 2,329 against 1,999. Later aggregate checks have not
run through that command.
