//! GitHub CLI integration. Catalog state belongs to the worker profile; these
//! worker-scoped operations do not require a checkout or a GitHub origin.
mod catalog;
mod process;
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_wire::Value;
use std::path::{Path, PathBuf};

pub struct Client {
    directory: PathBuf,
}
impl Client {
    pub fn new(directory: &Path) -> Self {
        Self {
            directory: directory.to_owned(),
        }
    }
    pub fn supports(kind: &str) -> bool {
        matches!(
            kind,
            "github.auth.status"
                | "github.repositories.cached"
                | "github.repositories.list"
                | "github.repository-owners.list"
                | "github.repositories.create"
        )
    }
    pub async fn execute(&self, command: &Value, scope: &Scope) -> Result<Value> {
        scope.check()?;
        match command["type"].as_str().unwrap_or("") {
            "github.auth.status" => self.auth_status(scope).await,
            "github.repositories.cached" => Ok(self.cached(&command["login"]).await),
            "github.repositories.list" => self.repositories(scope).await,
            "github.repository-owners.list" => self.owners(scope).await,
            "github.repositories.create" => self.create(&command["request"], scope).await,
            _ => bail!("Native GitHub command is not implemented."),
        }
    }
}
