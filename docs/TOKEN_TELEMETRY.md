# Token and quota telemetry

Cantrip stores immutable quota observations separately from per-execution token
usage. Quota observations describe an account window at a point in time. Token
usage records describe one concrete execution attempt, including attempts that
fail, are cancelled, are interrupted, or lose a provider-route failover.

## Counter semantics

Records marked `provider-reported-v2` preserve normalized runtime counters
without reconstructing or balancing them:

- `input_tokens` and `output_tokens` are the values reported by the runtime.
- `cached_input_tokens` and `cache_write_input_tokens` are additional input
  dimensions. They are not added to `input_tokens` because providers commonly
  report them as subsets.
- `reasoning_output_tokens` is an additional output dimension. It is not added
  to `output_tokens`; provider APIs differ on whether output already includes
  reasoning.
- `visible_output_tokens` is nullable and is populated only when the runtime can
  establish a non-reasoning/visible count without guessing.
- `reported_total_tokens` is the runtime's total verbatim. It may legitimately
  differ from `input_tokens + output_tokens` under a provider's accounting
  rules.
- `sanitized_raw_usage` contains only numeric usage fields and must never carry
  prompts, responses, credentials, headers, or account secrets.

Consequently, cached, cache-write, and reasoning counters must not be summed as
independent consumption on top of input/output. Analytics should display them as
breakdowns and retain the reported total as a separate series.

Rows migrated from the original aggregate implementation are marked
`legacy-derived-v1`. Their output count may have been reconstructed from total
and reasoning counters, so no raw or reported-total claim is made for them.

## Attribution and lifecycle

An execution attempt is identified independently from its chat. Legacy rows may
retain workflow attribution columns, but no current workflow runtime creates
attempts. The record captures the resolved provider account and route after failover,
worker, turn, applied reasoning effort, runtime versions, and start/completion
/finalization timestamps. A running row is created before dispatch and updated
in place as usage snapshots arrive. Terminal status is recorded even when the
attempt reports no token counters, since failed work may still consume quota.

## Derived quota correlation

Derived analytics are computed from the immutable ledgers; they never update a
quota observation or usage attempt. Readings are partitioned by exact provider
account, limit identity, window kind/duration, and reset timestamp. Cantrip does
not calculate deltas across those reset partitions.

Provider meters often have coarse percentage resolution. A stationary reading
is retained, while completed attempts continue accumulating from the previous
actual movement. When the meter next advances, the accumulated exact-account
attempts form one movement sample. Backwards movement inside the same reset
window is recorded as a rebaseline/provider correction, never as negative token
consumption. Meter movement without matching attempts is marked unattributed;
attempts after the last movement remain pending rather than being forced into a
sample.

The comparable token value used for an observed tokens-per-percentage estimate
is `input_tokens + output_tokens`. Cached input and reasoning output remain
separate breakdowns and are not added again. The provider-reported total is
also retained as its own series. Effective 100% allowance is an extrapolation
from observed movement samples, not an official provider limit.

Confidence is lowered when a movement window contains multiple models,
reasoning efforts, or projects; includes non-completed attempts; or has a large
worker-observation/server-receipt delay. Movement with no matching usage is low
confidence and excluded from allowance statistics. Every aggregate includes
sample counts and distribution statistics so sparse evidence is visible.

## Model behavior observations

Each interactive agent route attempt also has a lifecycle-updated behavior
observation. It records server-observed time to first activity and first visible
response, terminal duration/status, whether a final answer appeared, unique
tool and compaction counts, failed/declined tool outcomes, approval requests,
file counts, recognized test-command outcomes, context/usage counters, route
attempt/failover position, interruption state, and runtime attribution. The
activity reducer deduplicates streamed updates by activity ID.

Behavior telemetry does not copy prompts, responses, command text, command
output, file contents, or approval payloads. Commands are classified as tests
in memory and discarded. Copy, rating, and explicit regeneration signals are
stored as unavailable until their UI actions have a durable server event.
Forks are counted against the most recent source attempt. The
`immediate_corrective_followup` field is a deliberately coarse proxy: it is set
when a user sends another turn within two minutes of the latest assistant
message. It does not inspect or assert the meaning of either message and should
be labeled as heuristic in analysis.

## Historical model catalogs

Every catalog reconciliation writes a content-addressed metadata snapshot
before updating the current catalog projection. The SHA-256 hash is computed
from recursively key-sorted JSON containing only the already-sanitized model
catalog record. Identical metadata for the same provider, availability scope,
and native model is deduplicated; a changed record produces a new immutable
snapshot. Provider and model names are retained with the snapshot so later
renames or removal do not erase the historical series. Catalog snapshots never
contain API keys, account credentials, request headers, prompts, or responses.

## Change detection

The provider telemetry view derives conservative before/after signals from the
raw ledgers. It evaluates exact-account, exact-model, and account/model series
independently for observed tokens per percentage point, effective weekly
allowance, failure and completion rates, tool errors, latency, compaction
frequency, and reasoning/output mix.

Detection requires minimum samples on both sides of a candidate boundary and a
metric-specific minimum relative and absolute effect. Quota series exclude
unattributed samples and treat high-confidence movement samples as stronger
evidence. A signal is marked high confidence only when both sides have larger
sample sets, the effect materially exceeds the minimum threshold, and at least
three quarters of the samples are reliable. Otherwise a threshold-crossing
signal is medium confidence. The detector reports at most one strongest
boundary for a metric and scope within the selected range.

These are observational signals, not proof that a provider changed a model or
allowance. They can also reflect workload mix, routing, client/runtime changes,
or sparse sampling. The UI therefore shows the affected account/model, both
time ranges, before/after values, sample counts, and confidence instead of
describing a signal as an official provider policy change.

## Retention, export, and privacy

Telemetry is retained indefinitely by default because longitudinal comparisons
are the purpose of the ledger. Retention is owner-controlled:

- deleting the owning Cantrip account cascades through all telemetry;
- deleting a provider does not silently erase its historical quota evidence;
- the provider telemetry dialog can export all retained rows for that provider
  as versioned JSON; and
- the same dialog can explicitly and permanently delete that provider's quota,
  token, behavior, and catalog history without deleting the provider itself.

Exports contain stable identifiers, timestamps, numeric counters, runtime
versions, sanitized rate-limit/usage payloads, and sanitized catalog metadata.
They state that message content is excluded. Telemetry collection must never
add prompts, responses, file contents, command text/output, credentials,
authentication payloads, access tokens, request headers, or other secrets.
Existing conversation storage remains separate and is not copied into an
analytics export.

No automatic canary requests are enabled. Repeatable paid model checks remain
deferred until Cantrip can provide an explicit opt-in budget, schedule, stable
fixture contract, and clear account routing; telemetry must never consume quota
merely because analytics are enabled.
