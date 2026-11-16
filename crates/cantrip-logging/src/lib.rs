//! Structured logging, privacy boundaries, buffering, and owned archive lifecycle.
//! Callers supply process identity, clocks, console policy, and archive options.
mod http_status_names;
pub mod log_archive;
pub mod log_format;
pub mod log_records;
pub mod log_sanitize;
pub mod logging;
pub mod runtime;
