//! Existing Cantrip configuration parsing mechanisms, without runtime policy.
//! Callers own variable names, defaults, precedence, and process initialization.
pub mod env_file;
mod error;
mod reader;
mod value;

pub use error::{ConfigError, Result};
pub use reader::{Environment, Reader, enumeration};
pub use value::{entries, resolve};
