//! Cantrip's JavaScript-compatible wire values and serialization semantics.
//!
//! This library has no server, database, or network runtime. Protocol consumers
//! share the same UTF-16, numeric, property-order, and date behavior.
//! Callers embedding a runtime that mutates process locale or timezone must
//! initialize [`environment::timezone`] before starting that runtime.

pub mod coercion;
pub mod date;
mod digest;
pub mod environment;
mod json_text;
pub mod text;
pub mod value;

pub use digest::payload_digest;
pub use json_text::parse_json_text;
pub use value::{JsString, Value};
