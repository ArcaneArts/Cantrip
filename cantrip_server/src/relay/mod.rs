//! Shared relay quotas. Transport consumers use the same owner/worker budgets.
mod quotas;
pub use quotas::{RelayLimitError, RelayQuotaStats, RelayQuotas, SurfacePermit};
