//! Existing transport mechanisms used by Cantrip's server adapters.
//! These libraries do not establish a worker connection, route resources,
//! authorize identities, or coordinate Redis/durable execution ownership.
pub mod command_deadline;
pub mod correlation;
pub mod frames;
pub mod lifecycle;
pub mod notifications;
pub mod offline;
pub mod output;
pub mod peer;
