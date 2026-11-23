//! Worker-owned filesystem paths, storage and child lifetimes. No server or
//! database implementation is linked into these services.
pub(crate) mod chat_references;
pub(crate) mod chat_scratch;
pub(crate) mod command;
pub mod explorer;
pub mod folders;
pub mod paths;
pub mod repository;
pub(crate) mod scratch_files;
pub mod source_path;
pub mod storage;
pub use command::{ProcessError, Scope};
