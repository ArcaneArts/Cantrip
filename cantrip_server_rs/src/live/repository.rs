//! Scope authorization follows the reference repository's complete read path.
use crate::{
    auth::now, chats::Repository as ChatRepository, database::Database,
    projects::repository::ProjectRepository, wire::Value,
};
use anyhow::Result;
use std::sync::Arc;

pub struct LiveRepository {
    database: Arc<Database>,
    projects: ProjectRepository,
    chats: ChatRepository,
}
impl LiveRepository {
    pub fn new(database: Arc<Database>) -> Result<Self> {
        Ok(Self {
            projects: ProjectRepository::new(database.clone())?,
            chats: ChatRepository::new(database.clone()),
            database,
        })
    }
    pub async fn authorize(&self, owner: &str, scope: &Value) -> Result<bool> {
        match scope["kind"].as_str() {
            Some("current-user") => Ok(true),
            Some("project") => Ok(self
                .projects
                .list(owner)
                .await?
                .iter()
                .any(|project| project["id"] == scope["projectId"])),
            Some("chat") => match scope["chatId"].as_js_string() {
                // SQL text conversion replaces unpaired UTF-16 units; project
                // identity comparison above retains exact in-memory units.
                Some(id) => Ok(self
                    .chats
                    .execution_context(owner, &id.lossy())
                    .await?
                    .is_some()),
                None => Ok(false),
            },
            _ => Ok(false),
        }
    }
    pub async fn session_active(&self, session: &str, owner: &str) -> Result<bool> {
        Ok(!self.database.query("SELECT s.id FROM user_sessions s INNER JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>$3 AND u.status='active' LIMIT 1",&[&session,&owner,&now()]).await?.is_empty())
    }
}
