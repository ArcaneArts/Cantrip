use super::*;
impl Repository {
    pub async fn get(&self, owner: &str, cycle: &str) -> Result<Option<Value>> {
        one(Executor::Database(&self.database),"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.id=$2 LIMIT 1",&[&owner,&cycle]).await?.as_ref().map(summary).transpose()
    }
    pub async fn list(&self, owner: &str) -> Result<Value> {
        summaries(&all(Executor::Database(&self.database),"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 ORDER BY c.fifo_created_at ASC,c.id ASC",&[&owner]).await?)
    }
    pub async fn list_scheduler_owners(&self) -> Result<Vec<Value>> {
        let rows=self.database.query("SELECT DISTINCT owner_id,state FROM task_dispatch_cycles WHERE state IN ('queued','claimed','running','paused') ORDER BY owner_id ASC,state ASC",&[]).await?;
        let mut owners = crate::wire::value::Object::new();
        for row in rows {
            let owner = row.get::<String>(0)?;
            let state = row.get::<String>(1)?;
            let value=owners.entry(owner.clone().into()).or_insert_with(||json!({"ownerId":owner,"hasQueued":false,"hasClaimed":false,"hasRunning":false,"hasPaused":false}));
            let key = match state.as_str() {
                "queued" => "hasQueued",
                "claimed" => "hasClaimed",
                "running" => "hasRunning",
                "paused" => "hasPaused",
                _ => continue,
            };
            value[key] = json!(true);
        }
        Ok(owners.into_values().collect())
    }
}
pub fn scheduler_plan(owner: &Value) -> Value {
    json!({"reconcileUnstartedClaims":owner["hasClaimed"],"reconcileStartedLeases":owner["hasClaimed"]==true || owner["hasRunning"]==true,"resumePaused":owner["hasPaused"],"claimQueued":owner["hasQueued"]})
}
