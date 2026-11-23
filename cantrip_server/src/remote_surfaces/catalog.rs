//! Reuse the canonical resource projections, including legacy label/state joins.
use super::Repository;
use crate::{projects::targets::TargetRepository, wire::Value};
use anyhow::Result;

impl Repository {
    pub async fn list(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        TargetRepository::new(self.database.clone())
            .remote_surfaces(owner, project)
            .await
    }
    pub async fn desktops(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        TargetRepository::new(self.database.clone())
            .remote_desktops(owner, project)
            .await
    }
    pub async fn desktop(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        TargetRepository::new(self.database.clone())
            .remote_desktop(owner, id)
            .await
    }
}
