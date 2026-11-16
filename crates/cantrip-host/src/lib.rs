//! Small host resource mechanisms used by Cantrip server and future runtimes.
//! Paths, profile/storage policy, process creation, and supervision are caller-owned.
pub mod files;
pub mod process;
pub mod publish;
