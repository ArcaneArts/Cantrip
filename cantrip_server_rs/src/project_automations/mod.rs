//! Project automation state and worker-protected dispatch. Schedule evaluation
//! remains native; the unchanged worker owns plaintext prompts and conditions.
mod cron;
mod cron_date;
pub mod dispatch;
mod queries;
pub mod repository;
pub mod schedule;
