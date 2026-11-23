# Model operations delivery record

Source audit: November 7, 2026. The implementation supplies first-class language,
embedding and native decision profiles across configuration, discovery, both
servers, encrypted transport and worker execution. The [developer guide](MODEL_OPERATIONS.md)
contains the complete provider matrix, native formats, limits and reusable
`embed()` / `decide()` examples.

This record distinguishes implemented source paths from runtime qualification.
The user prohibited local tests, benchmarks, live inference probes and computer
use. No builds/typechecks or migration execution were performed either. This
delivery therefore does not claim that a provider, operating system or database
was exercised successfully.

## Requirement audit

| Requirement                             | Implemented source evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent operations and defaults     | `packages/protocol/src/model-operations.ts`, `providers.ts` and `settings.ts` define per-operation profiles/capabilities, typed adapter options and independently nullable embedding/decision defaults. Migration `0281` gives existing profiles the language operation and leaves both new defaults null. Discovery and provider creation never select either default.                                                                                                                                                                                                                       |
| Shared identity and scoped availability | One `provider_models` identity is shared by operation-specific profiles. `cantrip_server/src/db/repository/provider-catalog.ts` and `cantrip_server_rs/src/settings/catalog.rs` reconcile worker/account observations without borrowing another scope's classification. Both operation route resolvers prefer the selected worker's observations.                                                                                                                                                                                                                                             |
| Compatibility and deletion              | Both settings repositories preserve omitted fields and distinguish null resets from omissions. Profile operation changes are rejected to protect existing references. Foreign keys clear deleted-profile defaults; both provider deletion transactions clear only defaults whose last enabled route was removed. Offline/stale providers retain selection.                                                                                                                                                                                                                                    |
| Discovery and provider truth            | The registry, worker endpoint normalizer, native Ollama metadata and OpenRouter catalog preserve advertised operation types/modalities. LiteLLM overlays only authorized public aliases; Unsloth requests its all-operation catalog. The guide documents every current provider and separates subscription, API-key and custom serving contracts. Unknown metadata is not asserted as unsupported.                                                                                                                                                                                            |
| Partial catalogs and scale              | `cantrip_worker/src/model-catalog-snapshots.ts` transfers complete bounded snapshots, with deduplication, concurrency/cache limits and paging. TypeScript and Rust wait for complete transfers before reconciliation. Incomplete optional metadata keeps prior observations and missing models stale; connection changes invalidate old capability observations without deleting configurations/defaults.                                                                                                                                                                                     |
| Settings and language choices           | Provider sections render in Language, Embedding, Decision order with counts, search, manual configuration, operation-appropriate fields and default actions. `OperationDefaultPicker` supports None selected and retained unavailable selections. Bounded settings pages search all profiles. Shared language pickers, title/import choices and native root/subagent/transfer choices exclude incompatible operation profiles. Edited legacy language profiles remain recoverable with a presentation conflict.                                                                               |
| Reusable encrypted entry points         | `cantrip_app/src/lib/api/model-operations.ts` exports `embed()` and `decide()` through the existing API barrel, protects content for the selected worker, binds the account identity, forwards cancellation and disables automatic replay. TypeScript `app/routes/model-operations.ts` and Rust `http/model_operations.rs` authorize worker ownership, resolve defaults/explicit routes and relay opaque commands. Worker `commands/model-operations.ts` decrypts credentials/content and protects results. No synthetic chat, task, goal or Codex session is created.                        |
| Embedding execution and vector identity | `cantrip_worker/src/model-embedding.ts` and `model-embedding-formats.ts` implement bounded ordered batches, native text/media formats, dense/base64, sparse, token/multi-vector and hybrid representations, dimensions/input modes and cancellation. Identity fingerprints bind configured and reported model, revision provenance, native endpoint/adapter, input pipeline and effective options. Pinned expected spaces bypass later default changes; mismatches fail. No unestablished fallback or media conversion is used.                                                               |
| Typed native decisions                  | `model-decision.ts`, `model-decision-media.ts` and `model-decision-questions.ts` adapt native OpenAI, System One and isolated OpenRouter alpha formats. They preserve question/choice identities, native answers, probabilities, ordered score semantics, confidence, refusals, errors and actual model/provider fields. Missing/malformed answers fail; explicit per-question errors remain partial. Question-specific images and fixed-question omission are represented without a chat emulation fallback.                                                                                 |
| Shared admission and lifecycle          | Both executable operations call the existing `WorkerInferenceAdmission.runDirect()` service, using actual canonical command sources and the same provider pools as native inference. HTTP/body teardown precedes settlement; timeouts start after admission. Embedding batches release/rejoin FIFO. `InferencePreparation` and `CodexInferenceExecution.prepareModelOperations()` explicitly own sequential borrowing, independent concurrent children, cross-provider yielding and retirement/shutdown joins. Cancellation and replay handling do not claim that remote computation stopped. |
| Usage and privacy                       | Count-only opt-in receipts feed the existing token ledger in both servers. Missing counters/coverage remain unknown; completed batches survive later failure in observed usage. Terminal receipts are immutable and inference is not replayed to recover telemetry. Routine logs/receipts contain no content, vectors or credentials. No artificial chat time is recorded.                                                                                                                                                                                                                    |
| Shared persistence/server definitions   | SQL migrations `0281`, `0282`, `0283`, `0285` and `0286` are registered in the shared Drizzle journal, which the Rust build embeds. Both servers implement profile/default CRUD, scoped catalog reconciliation, route resolution, cancellation, usage and default cleanup. Generated Rust transport contracts were refreshed when shared wire definitions changed. Protected inference contents are validated by the client/worker under the same protocol definitions.                                                                                                                       |

## Evidence and practical limits

Each implementation PR received source/diff review, formatting and
`git diff --check`. Shared transport changes also received necessary mechanical
protocol JavaScript emission and Rust contract export; these are code generation,
not execution validation. The last export during the native question update
contained 803 roots and 12,453 nodes, with no resulting tracked contract change
because the updated question content is encrypted end to end.

GitHub reported every implementation PR below merged. Their merge states were
observed, including a final query covering all 20 implementation PRs. The current
manual change protocol reserves hosted Actions for releases/deployments; ordinary
PR CI was not dispatched, and an empty check rollup is not a passing test result.
No required check or branch protection was bypassed.

The remaining limits are explicit platform/upstream boundaries:

- Supported operations depend on the actual served model, installed backend,
  enabled API, account access and upstream media/question limits. Subscription
  passthrough does not confer API-key access. MLX-LM, xAI API and Z.ai additional
  operation interfaces remain unverified where no applicable public contract was
  established; explicit compatible configuration remains available.
- Each protected input/output and native HTTP payload is bounded to 4 MiB, and
  the complete worker command to 7 MiB. Larger jobs/media require caller-side
  grouping. Providers with mutable aliases may not report a weights revision;
  `revisionVerified: false` is retained. Future indexes must store the returned
  identity and establish revision/query-document compatibility explicitly.
- Gateway configuration can discard unsupported parameters upstream. Cantrip
  preserves supplied media and uses documented envelopes, but cannot prove an
  upstream consumed it merely from a successful response. Embedding-space
  equivalence is never inferred from equal dimensions.
- The replay ledger retains 10,000 operation IDs per worker incarnation and
  refuses additional operations when full rather than losing replay protection.
  Missing usage receipts after disconnect/crash are unknown; this path has no
  durable worker telemetry outbox. Cancelling local HTTP ownership does not prove
  a remote provider stopped inference.

## Merged implementation PRs

Every row was authored on its own `codex/` branch and isolated temporary worktree,
requested squash automerge, and was observed merged before dependent work began.
Owned implementation worktrees and local branches were removed after merge;
unrelated worktrees were preserved.

| PR                                                       | Branch                                    | Delivery                                                                                   |
| -------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| [#2710](https://github.com/ArcaneArts/Cantrip/pull/2710) | `codex/model-operations-foundation`       | Capability contracts, operation profiles, nullable defaults, persistence and server parity |
| [#2711](https://github.com/ArcaneArts/Cantrip/pull/2711) | `codex/model-operation-discovery`         | Operation-aware catalog discovery and reconciliation                                       |
| [#2712](https://github.com/ArcaneArts/Cantrip/pull/2712) | `codex/model-operation-route-config`      | Per-route adapters/options and backward-compatible updates                                 |
| [#2714](https://github.com/ArcaneArts/Cantrip/pull/2714) | `codex/model-provider-operation-registry` | API-key worker discovery and documented capability registry                                |
| [#2715](https://github.com/ArcaneArts/Cantrip/pull/2715) | `codex/model-operation-settings`          | Separate provider sections, operation forms and independent default selectors              |
| [#2716](https://github.com/ArcaneArts/Cantrip/pull/2716) | `codex/direct-inference-ownership`        | Direct HTTP ownership in existing provider admission                                       |
| [#2719](https://github.com/ArcaneArts/Cantrip/pull/2719) | `codex/model-embedding-execution`         | Encrypted app/server/worker embedding execution and pinned identity                        |
| [#2720](https://github.com/ArcaneArts/Cantrip/pull/2720) | `codex/native-decision-execution`         | Native typed decisions with authenticated transport and admission                          |
| [#2722](https://github.com/ArcaneArts/Cantrip/pull/2722) | `codex/native-embedding-formats`          | Multimodal, sparse, multi-vector and hybrid embedding formats                              |
| [#2723](https://github.com/ArcaneArts/Cantrip/pull/2723) | `codex/model-selection-integrity`         | Language selection filtering and deleted-provider default cleanup                          |
| [#2725](https://github.com/ArcaneArts/Cantrip/pull/2725) | `codex/paged-model-catalogs`              | Complete bounded catalog paging and snapshot transfer                                      |
| [#2726](https://github.com/ArcaneArts/Cantrip/pull/2726) | `codex/model-operation-usage`             | Count-only direct-operation usage receipts and server persistence                          |
| [#2728](https://github.com/ArcaneArts/Cantrip/pull/2728) | `codex/partial-model-discovery`           | Partial refresh retention and connection capability invalidation                           |
| [#2729](https://github.com/ArcaneArts/Cantrip/pull/2729) | `codex/scalable-model-settings`           | Bounded settings lists and full configured-model search                                    |
| [#2730](https://github.com/ArcaneArts/Cantrip/pull/2730) | `codex/native-model-operation-ownership`  | Structured native preparation and dependent HTTP ownership                                 |
| [#2731](https://github.com/ArcaneArts/Cantrip/pull/2731) | `codex/legacy-model-operation-selection`  | Recoverable legacy profiles excluded from incompatible language choices                    |
| [#2732](https://github.com/ArcaneArts/Cantrip/pull/2732) | `codex/native-decision-media`             | Native backend media envelopes and explicit TypeSafe image extension                       |
| [#2734](https://github.com/ArcaneArts/Cantrip/pull/2734) | `codex/litellm-operation-catalog`         | Credential-safe LiteLLM alias metadata discovery                                           |
| [#2735](https://github.com/ArcaneArts/Cantrip/pull/2735) | `codex/native-decision-question-shapes`   | Fixed/large native questions and question-specific images                                  |
| [#2736](https://github.com/ArcaneArts/Cantrip/pull/2736) | `codex/unsloth-native-model-operations`   | Verified Unsloth APIs, media, all-operation discovery and no default truncation            |
