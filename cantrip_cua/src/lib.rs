pub mod backend;
pub mod cancellation;
mod click_sequence;
pub mod cursor;
mod cursor_motion;
pub mod effects;
pub mod error;
pub mod gesture;
pub mod input;
pub mod input_job;
pub mod interaction;
mod interaction_sprite;
pub mod inventory;
mod javascript;
pub mod protocol;
pub mod remote_capture;
pub mod runtime;
pub mod service;
pub mod target;
pub mod timeline;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(any(target_os = "macos", test))]
mod window_traversal;
