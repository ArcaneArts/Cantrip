//! Native worker implementation. Modules are integrated progressively while the
//! existing production worker remains the default until the complete cutover.
pub mod attachments;
pub mod config;
pub mod connection;
pub mod credentials;
pub mod encryption;
pub mod error;
pub mod explorer_operations;
pub mod filesystem;
pub mod git;
pub mod github;
pub mod history;
pub mod http;
pub mod installation;
pub mod logging;
pub mod metadata;
pub mod native_items;
pub mod platform;
pub mod protected_content;
pub mod protected_secrets;
pub mod replicas;
pub mod repository_operations;
pub mod routing;
pub mod runtime;
pub mod terminal_services;
pub mod version;
pub mod workspace;
