use crate::{
    database::{Database, query_error::context},
    wire::{Value, coercion},
};
use anyhow::{Result, ensure};
use std::sync::{Arc, OnceLock};

#[derive(serde::Deserialize)]
pub struct Queries {
    pub list: String,
    pub status: String,
}
pub fn queries() -> &'static Queries {
    static QUERIES: OnceLock<Queries> = OnceLock::new();
    QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("queries.json"))
            .expect("embedded terminal query manifest")
    })
}
#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn list(&self, worker: &str, server: &str) -> Result<Vec<Value>> {
        let rows = context(self.database.query(
            "SELECT to_jsonb(t)::text,w.absolute_path FROM terminals t INNER JOIN project_worktrees w ON w.id=t.worktree_id WHERE w.worker_id=$1 AND t.service_enabled=$2",
            &[&worker, &true],
        ).await, &queries().list, &[Value::String(worker.into()), Value::Bool(true)])?;
        rows.iter()
            .map(|row| {
                let terminal: Value = serde_json::from_str(&row.get::<String>(0)?)?;
                ensure!(
                    coercion::truthy(terminal.get("protected_state")),
                    "Terminal service protection is unavailable."
                );
                Ok(Value::object([
                    ("terminalId", terminal["id"].clone()),
                    ("serverId", Value::String(server.into())),
                    ("worktreePath", Value::String(row.get::<String>(1)?.into())),
                    ("stateProtection", terminal["protected_state"].clone()),
                ]))
            })
            .collect()
    }
    pub async fn set_status(&self, terminal: &str, status: &str) -> Result<()> {
        let at = crate::auth::now();
        context(
            self.database
                .query(&queries().status, &[&status, &at, &terminal])
                .await,
            &queries().status,
            &[
                Value::String(status.into()),
                Value::String(crate::auth::iso(at).into()),
                Value::String(terminal.into()),
            ],
        )?;
        Ok(())
    }
}
