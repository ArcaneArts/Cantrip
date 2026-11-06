//! The existing Node relay namespace, envelopes and ownership fences.
//! Redis coordinates routing; SQL remains the durable execution authority.
mod core;
mod redis;
mod service;
pub use core::{Listener, MAX_MESSAGE_BYTES};
pub use redis::{Options, RedisCoordinator};
pub use service::RelayCoordinator;
