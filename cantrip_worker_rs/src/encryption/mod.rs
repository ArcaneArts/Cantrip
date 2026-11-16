//! Worker-owned endpoint identity. Authenticated grants, protected domain
//! adapters and encrypted streams are implemented in subsequent port cycles.
mod identity;
pub use identity::{Identity, IdentityError};
