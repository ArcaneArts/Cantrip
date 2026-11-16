pub mod coordinator;
pub mod exports;
pub mod git_operations;
pub mod observations;
pub mod placement;
mod placement_queries;
pub mod removal;
pub mod replicas;
pub mod repository;
pub mod repository_operation;
pub mod targets;
pub mod worktrees;

pub(crate) use cantrip_protocol::project_capabilities::capabilities;

pub mod folders;
pub mod github_conversion;
pub mod workspace_discovery;
pub mod workspaces;
