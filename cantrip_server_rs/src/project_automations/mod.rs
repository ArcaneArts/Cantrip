//! Project automation state and worker-protected dispatch. Schedule evaluation
//! remains native; the unchanged worker owns plaintext prompts and conditions.
pub mod dispatch;
mod queries;
pub mod repository;
pub use cantrip_scheduling as schedule;
