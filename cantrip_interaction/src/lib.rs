//! Platform-independent interaction primitives. No agent, transport, or OS dependencies.
pub mod capabilities;
pub mod cursor;
pub mod error;
pub mod geometry;
pub mod host;
pub mod input;
pub mod motion;
pub mod presentation;
pub mod rendering;
pub mod schedule;
pub mod telemetry;

pub mod ownership;

#[cfg(feature = "sprites")]
pub mod sprite;
