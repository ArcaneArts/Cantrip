use super::*;
use crate::database::Transaction;
use std::sync::OnceLock;

fn current(job: &Value, kind: &str, command: &str, result: &Value) -> bool {
    !job.is_null()
        && job["kind"] == kind
        && job["state"] == "running"
        && job["command_id"] == command
        && job["id"] == result["jobId"]
        && job["attempt"] == result["attempt"]
        && job["root_id"] == result["rootId"]
        && job["chat_id"] == result["chatId"]
}
async fn complete_row(tx: &Transaction<'_>, row: &Value, command: &str) -> Result<Value> {
    let id = text(&row["id"])?;
    let at = crate::auth::now();
    let rows=tx.query("UPDATE standalone_chat_root_jobs SET state='succeeded',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,last_error_code=NULL,error_retryable=NULL,completed_at=$3,updated_at=$3 WHERE id=$1 AND command_id=$2 RETURNING to_jsonb(standalone_chat_root_jobs)::text",
        &[&id,&command,&at]).await?;
    raw(rows.first().ok_or(RootJobError::Stale(
        "The standalone Chat scratch completion lost its lease.",
    ))?)
}
impl Repository {
    pub async fn complete_provision(
        &self,
        id: &str,
        command: &str,
        result: &Value,
    ) -> Result<Value> {
        static HANDLE: OnceLock<regress::Regex> = OnceLock::new();
        let pattern = HANDLE.get_or_init(|| {
            regress::Regex::with_flags(r"^ctrr_[A-Za-z0-9_-]{43}$", "u")
                .expect("static scratch handle regex")
        });
        // Match the reference's ECMAScript regex over the original UTF-16.
        // The database also retains its original path constraint check.
        anyhow::ensure!(
            result["path"]
                .as_js_string()
                .is_some_and(|value| pattern.find_from_utf16(value.units(), 0).next().is_some()),
            RootJobError::Conflict("The worker did not return an opaque scratch routing handle.")
        );
        let (id, command, result) = (id.to_owned(), command.to_owned(), result.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM standalone_chat_root_jobs j WHERE id=$1 LIMIT 1 FOR UPDATE",&[&id]).await?;
            let job=rows.first().map(raw).transpose()?.unwrap_or(Value::Null);
            anyhow::ensure!(current(&job,"provision",&command,&result),RootJobError::Stale("The standalone Chat provision completion is no longer current."));
            let root=text(&job["root_id"])?;let chat=text(&job["chat_id"])?;let owner=text(&job["owner_id"])?;let worker=text(&job["worker_id"])?;let path=text(&result["path"])?;
            let roots=tx.query("UPDATE standalone_chat_roots SET protected_path_handle=$5,status='ready',provisioning_revision=provisioning_revision+1,updated_at=$6 WHERE id=$1 AND chat_id=$2 AND owner_id=$3 AND worker_id=$4 RETURNING id",
                &[&root,&chat,&owner,&worker,&path,&crate::auth::now()]).await?;
            anyhow::ensure!(!roots.is_empty(),RootJobError::Conflict("The standalone Chat scratch root changed during provisioning."));
            summary(&complete_row(tx,&job,&command).await?)
        })).await
    }
    pub async fn complete_delete(&self, id: &str, command: &str, result: &Value) -> Result<Value> {
        let (id, command, result) = (id.to_owned(), command.to_owned(), result.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM standalone_chat_root_jobs j WHERE id=$1 LIMIT 1 FOR UPDATE",&[&id]).await?;
            let job=rows.first().map(raw).transpose()?.unwrap_or(Value::Null);
            anyhow::ensure!(current(&job,"delete",&command,&result),RootJobError::Stale("The standalone Chat deletion completion is no longer current."));
            summary(&complete_row(tx,&job,&command).await?)
        })).await
    }
}
