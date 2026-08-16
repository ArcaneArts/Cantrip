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

An execution attempt is identified independently from its chat or workflow.
The record captures the resolved provider account and route after failover,
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
