pub mod placement;
pub mod repository;
pub mod targets;

use serde::Serialize;

#[derive(Serialize)]
pub(crate) struct Capabilities {
    pub git: bool,
    pub github: bool,
    pub worktrees: bool,
    pub replicas: bool,
    pub relocation: bool,
}
pub(crate) fn capabilities(origin: &str, git: bool, github: bool) -> Capabilities {
    let remote = origin == "github";
    let git = remote || git;
    let local_git = origin == "managed-folder" && git;
    Capabilities {
        git,
        github: remote || github,
        worktrees: remote,
        replicas: remote || local_git,
        relocation: remote || local_git,
    }
}
pub mod folders;
