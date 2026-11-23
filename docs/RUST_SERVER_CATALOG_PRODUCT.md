# Full-worker provider catalog qualification

The existing browser SDK, production servers and complete worker now share a
provider catalog scenario covering pagination, partial metadata, discovery,
worker scopes, inference routing and retained state. Only the provider's public
HTTP responses are controlled. Authentication, encryption grants, worker
transport, snapshot paging and database reconciliation use production code.

No production Rust, Node server or worker change was required. Node remains the
default server and full replacement remains incomplete.

## Product assertions

`actual-folder-client.mjs --provider-catalog` creates five provider configurations
using four endpoint dialects: OpenAI-compatible, LM Studio, LiteLLM and Unsloth.

- A 1,050-model catalog follows five provider HTTP pages. Descriptions alone
  exceed 4 MiB, so the inventory cannot fit the worker's legacy full-snapshot
  limits of 1,000 models and 4 MiB. The actual paged snapshot protocol carries
  the complete inventory. While the second provider page is held, existing
  profiles remain intact; no partial inventory is reconciled.
- Failed, foreign-origin and repeating continuations retain catalog data,
  availability and profile identities. The foreign-origin trap receives no
  request. A later complete small inventory marks missing models unavailable.
- A malformed LM Studio native overlay discards its valid prefix, retains
  standard metadata and preserves native-only models. A later complete
  observation can mark an omitted native model unavailable.
- LiteLLM exposes public aliases and conservative operation capabilities,
  including the minimum embedding input limit across deployments. Private
  deployment IDs, credentials, upstream model names and unlisted aliases do not
  reach the public catalog. Partial native metadata retains earlier capabilities.
- Unsloth discovery requests all output modalities. Unclassified non-language
  tasks do not acquire language profiles; native decisions retain their adapter.
- Two actual workers report contradictory capabilities for one public alias.
  Independent availability scopes, the existing discovered language profile,
  an explicit language profile and the explicit default survive. A separate
  discovered embedding route executes through the secondary worker and records
  its actual two-token receipt. After that worker stops, refresh serves its
  stale cache without another provider request.
- Actual server/worker restart retains every catalog/profile identity, all data,
  exact creation timestamps, explicit defaults and server/owner identity.
  Other observation timestamps may advance but cannot move backwards.

Each peer records 26 snapshots. Comparisons preserve missing/null distinctions
and every normalized field and array row, with relational identity labels,
validated timestamps and description byte counts plus SHA-256 digests. Separate
within-peer retention checks use raw values rather than normalized identities.

## Executed local matrix

Source baseline: `b77899188ccf1588840f11f9431f7d72b85d9049`.
Unchanged Rust executable SHA-256:
`20bb778bd097862de7be6e51ee9d2c90c57dce27700c14e856b53ce36054b985`.

| Configuration                                         | Cells | Product steps | Compared snapshots |
| ----------------------------------------------------- | ----: | ------------: | -----------------: |
| Node and Rust, external PostgreSQL                    |     2 |            32 |                 52 |
| Node and Rust, bundled PostgreSQL                     |     2 |            32 |                 52 |
| Node and Rust, PGlite                                 |     2 |            32 |                 52 |
| Node/Node, Node/Rust, Rust/Node, Rust/Rust over Redis |     4 |            64 |                104 |
| Total                                                 |    10 |           160 |                260 |

All seven final matrix processes exited zero. All ten cells match the same
normalized baseline. There are 42 clean production-server exits and 50 clean
worker exits, with no intentional crash in this scenario. A separate post-run
audit checks all 84 complete server stdout/stderr logs for both private markers.

Shared cells use actual Redis 8.10.3 and place the browser and both workers on
opposite peers. Actual Redis ownership is checked. The restart closes both
servers, retains their ports and database, assigns fresh instance IDs and starts
them again while Redis remains running.

The platform is macOS arm64 with account authentication. The bundled PostgreSQL
Node reference connects to a private fixture database; Rust manages its private
PostgreSQL process. PGlite uses an owned runtime materialization. The worker has
fresh current worker, protocol, crypto, logging and version builds. Frozen
protocol/crypto/logging JavaScript was byte-identical to current builds; only
version metadata differed. Installed direct dependency versions also match.

Final reports are `{postgres,bundled-postgres,pglite}-matrix-v3.json`,
`mixed-node-rust-v2.json` and `mixed-{node-node,rust-node,rust-rust}-v3.json`, with
`final-comparison.json` and the post-run verifier under
`.qa/rust-provider-catalog-product` in the retained evidence.

Earlier failures remain in the evidence. The first scenario used the wrong
location for `defaultModelId`; the SDK returns it in `preferences`. Another new
assertion incorrectly required an observation clock to remain fixed: settings
reads start a legitimate background refresh that can reconcile the same complete
worker snapshot again. The corrected assertions retain exact data/identities and
require monotonic observation clocks. An initial shared run failed to spawn
Redis from PATH; final runs use the existing verified binary explicitly. None
of these failures required a production implementation change.

Fresh production Node/worker and workspace builds, formatting, current generated
contract comparisons, the server-boundary audit and release-only workflow audit
pass locally. `pnpm check` still stops at unchanged Node line budgets:
`build-app.ts` 1,532/1,500 and `chat-turn-runtime.ts` 2,336/1,999; downstream
checks did not run. No development GitHub Actions jobs were dispatched.

This result covers healthy Redis and orderly cluster restart, rather than
interrupted catalog transfer, long outages, Redis TLS or network partitions.
It does not establish other operating systems, final packaged artifacts,
performance, every external provider implementation or default cutover.
Current CantripOS lifecycle/failure/recovery, remaining interruption scenarios,
final migration/rollback and platform/deployment acceptance, Rust default
selection and production Node-server removal remain required.
