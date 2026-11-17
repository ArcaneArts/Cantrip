//! Native worker implementation. Modules are integrated progressively while the
//! existing production worker remains the default until the complete cutover.
pub mod config;
pub mod connection;
pub mod credentials;
pub mod encryption;
pub mod http;
pub mod installation;
pub mod logging;
pub mod platform;
pub mod protected_content;
pub mod protected_secrets;
pub mod runtime;
pub mod version;
