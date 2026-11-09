# Worker enrollment and credential lifecycle diagnostics

The native worker HTTP routes now capture enrollment-code creation, enrollment
completion/rejection and credential rotation/revocation through the shared server
logger. The initial production comparison completed the same 25 HTTP steps on
both servers, with ten persisted Node lifecycle records and zero native records.
Both processes exited cleanly. That original failure remains retained.

The diagnostics follow the existing operation boundaries: code creation after
the insert, enrollment after audit and presence publication, rejection after the
denied audit, and rotation/revocation after credential effects and disconnect.
Rotation includes previous credential history, successful delivery and degraded
delivery outcomes. Invalid bodies, missing resources and rejected rotation do
not acquire invented lifecycle records. SQL, credential policy and worker product
code are unchanged.

Enrollment rejection retains the reference worker-specific key, five-minute
window and summary after five suppressed repetitions. Seven attempts with one
consumed code exercise suppression and a summary; a second worker exercises an
independent key. Tests compare the actual persisted records and request IDs.

## Console fields and JSON omission

The stricter production console check found another difference after record
capture was implemented. Node retains explicit `replacedWorkerId=undefined` on
ordinary enrollment and `reasonCode=undefined` on successful rotation. These own
properties disappear from serialized JSON. The JSON-only native value type could
not represent that distinction.

The shared emitter now accepts explicit undefined context fields through a
separate argument. Null placeholders preserve console field positions. The
console renderer displays those fields as undefined, while serialized emitter
outputs and archive admission omit them. Ordinary JSON null and the literal
string `"undefined"` retain their original meanings. The protocol JSON value type
is unchanged.

Sanitization still applies first. Secret fields retain redaction, and fields
removed by sanitization or the context size limit cannot reappear through the
rendering argument. Ordinary capture avoids the extra record clone when no
undefined fields are present.

Fourteen additional cases execute the actual Node service logger, with and
without color. They compare console output and serialized native emitter records
for optional properties, null, a literal undefined string, numeric property
order, secret fields, prototype keys and context truncation. The existing
formatter and service-log sanitization/noise comparisons remain enforced.

## Production qualification

The debug matrix passes all nine combinations of native PGlite, private bundled
PostgreSQL and external PostgreSQL with none/password/accounts authentication.
It runs 28 production processes: 26 ordinary zero exits and two expected
startup-failure exits of one. Eighteen lifecycle peers make 540 recorded helper
HTTP requests and retain 216 decision records, yielding 108 paired record
comparisons. Whole-server record counts are not asserted equal.

The optimized executable repeats all nine lifecycle pairs with Rust started
first and adds the existing HTTP/database/key-initialization regressions. Its
forty production processes retain thirty ordinary zero exits and ten deliberate
startup/key-failure exits of one. The same 540 helper HTTP requests and 216
lifecycle records pass. Actual paired bootstrap responses report version
1.1.2772. The macOS ARM64 executable is 94,214,064 bytes with SHA-256
`a995b3d9ddcbf3d9355b4b3a007f931fc5de56549f2a3a92a39b2d9787a9eccc`.

The existing enrollment/App Live regression also passes all nine pairs through
its production app/router composition: eighteen clean fixture-process exits,
99 paired HTTP observations and 81 paired publication observations. Its actual
response-completion invalidation assertions remain enforced.

The scenarios cover:

- Enrollment creation, candidate identity, successful exchange, consumed-code
  rejection, repeated warnings and malformed input.
- Online credential delivery through the unchanged worker transport and real
  credential store, offline rotation, a worker-reported delivery failure, and
  revocation. Full console records retain the actual credential-history counts.
- Rejected rotation after the final credential is revoked, missing resources
  and malformed rotation bodies.
- In account mode, a separately enrolled worker is replaced by a new identity
  for a second real registered owner. A self-replacement attempt first returns
  409 and leaves the code pending. The same code then succeeds with the new
  identity. The previous owner cannot read the new worker's credentials; the
  previous credential is rejected; the new credential works and its owner can
  revoke it.

Every selected record correlates to its actual HTTP response request ID. Full
console checks also verify code identity, expiration policy, platform,
architecture, optional replacement identity and rotation reason/history.
Raw enrollment codes, credential secrets and private labels are absent from
both console and persisted records.

Endpoint command effects are controlled. These tests use the production
`WorkerConnection` and credential store, but do not establish full worker
filesystem or native execution acceptance.

All 80 library tests, strict all-target Clippy, sixteen generated schema/provider
comparisons, boundary and retired-workflow checks pass locally. The formatter
and service-log integration tests also pass. The standard `pnpm check` stops at
unchanged Node decomposition budgets: 1,539/1,500 and 2,336/1,999. The separate
repository budget reports 2,284/2,000. Actual clean-Primary checks reproduce these
failures, with matching hashes for all three files and both check scripts.
Later aggregate stages are not reported as passing.

The retained fixture-development failures distinguish actual port defects from
incorrect setup assumptions. Node rejects rotation after the last revocation
and replacing a worker with its own identity; the public code-status response
uses `status: "pending"`. The corrected scenarios exercise those actual contracts
and retain their assertions.

```sh
node --import tsx scripts/server-rust/log-runtime-server-compatibility.mjs \
  --worker-lifecycle-records --report /absolute/path/lifecycle.json
node scripts/server-rust/cargo.mjs test --test log_format --test service_logs
```

Supply the existing isolated database/runtime environment and set
`CANTRIP_RUST_SERVER_BINARY` to the exact candidate. The reference executes
`cantrip_server/src/index.ts`, and native requests run through the production
Rust executable. Development validation runs locally; no Actions or production
deployment is used.

Node remains the default server and the worker remains Node. Remaining production
diagnostic/background consumers, complete current product/fault/coordination,
supported artifacts/platforms, historical upgrades and post-write rollback,
performance, Rust default selection and production Node-server removal remain
required for full replacement.
