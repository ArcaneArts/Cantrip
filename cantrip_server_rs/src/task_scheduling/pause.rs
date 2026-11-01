use super::*;
fn summary(row: &Value) -> Result<Value> {
    parse(
        "projectTaskPauseStateSchema",
        &json!({"projectId":row["id"],"paused":row["task_scheduling_paused"],"pausedAt":if row["task_scheduling_paused_at"].is_null(){Value::Null}else{crate::native_commands::receipt::iso(&row["task_scheduling_paused_at"])?},"rowVersion":row["task_scheduling_revision"]}),
    )
}
impl Repository {
    pub async fn project_pause(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        one(
            Executor::Database(&self.database),
            "SELECT to_jsonb(p)::text FROM projects p WHERE id=$1 AND owner_id=$2 LIMIT 1",
            &[&project, &owner],
        )
        .await?
        .as_ref()
        .map(summary)
        .transpose()
    }
    pub async fn set_project_pause(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let (at, owner, project, input) =
            (now(), owner.to_owned(), project.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move{
            if tx.query("SELECT id FROM users WHERE id=$1 LIMIT 1 FOR UPDATE",&[&owner]).await?.is_empty(){return Ok(None);}
            let fields=json!({"task_scheduling_paused":input["paused"],"task_scheduling_paused_at":if truthy(input.get("paused")){at.clone()}else{Value::Null},"updated_at":at});let fields=fields.stringify();let version=(!input["rowVersion"].is_null()).then(||input["rowVersion"].stringify());
            let updated=one(Executor::Transaction(tx),"UPDATE projects p SET task_scheduling_paused=d.task_scheduling_paused,task_scheduling_paused_at=d.task_scheduling_paused_at,task_scheduling_revision=p.task_scheduling_revision+1,updated_at=d.updated_at FROM jsonb_populate_record(NULL::projects,$4::text::jsonb) d WHERE p.id=$1 AND p.owner_id=$2 AND p.task_scheduling_revision=$3::text::integer RETURNING to_jsonb(p)::text",&[&project,&owner,&version,&fields]).await?;
            if let Some(row)=updated{return summary(&row).map(Some);}
            if !tx.query("SELECT id FROM projects WHERE id=$1 AND owner_id=$2 LIMIT 1",&[&project,&owner]).await?.is_empty(){return conflict("stale-version","The Project Task pause state changed before this update was applied.");}Ok(None)
        })).await
    }
}
