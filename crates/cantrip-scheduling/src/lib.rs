//! Pure automation schedule evaluation using the existing Cantrip wire semantics.
//!
//! `first` and `next` accept an already validated automation schedule. They
//! compute occurrences only; database scheduling, dispatch, and ownership are
//! the caller's responsibility.
mod cron;
mod cron_date;
mod schedule;

pub use schedule::{cron_error, first, next, timezone};
