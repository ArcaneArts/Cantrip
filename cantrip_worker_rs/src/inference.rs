//! Worker admission persistence and native OS-lease ownership. Queue policy
//! remains worker-owned; the existing Rust keeper is the durable writer.
pub mod admission;
pub mod identity;
pub mod journal;
pub mod ownership;
