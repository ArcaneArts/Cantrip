use super::*;
fn configuration_columns(configuration: &Value) -> Value {
    let mut fields = Value::object([] as [(&str, Value); 0]);
    for (column, key) in [
        ("model_id", "modelId"),
        ("reasoning_effort", "reasoningEffort"),
        ("custom_subagent_model", "customSubagentModel"),
        ("subagent_model_id", "subagentModelId"),
        ("subagent_reasoning_effort", "subagentReasoningEffort"),
    ] {
        if let Some(value) = configuration.get(key) {
            fields[column] = value.clone();
        }
    }
    fields
}
impl Repository {
    pub async fn list_workers(&self, owner: &str) -> Result<Value> {
        let parameters: Parameters<'_> = &[&owner];
        let (rows,counts)=tokio::try_join!(all(Executor::Database(&self.database),"SELECT to_jsonb(w)::text FROM task_workers w WHERE owner_id=$1 AND deleted_at IS NULL ORDER BY position ASC,id ASC",parameters),self.database.query("SELECT selected_task_worker_id,count(*)::int FROM task_dispatch_cycles WHERE owner_id=$1 AND state IN ('claimed','running') GROUP BY selected_task_worker_id",parameters))?;
        let mut active = HashMap::new();
        for row in counts {
            if let Some(id) = row.get::<Option<String>>(0)? {
                active.insert(id, row.get::<i32>(1)? as i64);
            }
        }
        let values = rows
            .iter()
            .map(|row| worker_summary(row, *active.get(&text(&row["id"])?).unwrap_or(&0)))
            .collect::<Result<Vec<_>>>()?;
        parse("taskWorkerListSchema", &Value::Array(values))
    }
    pub async fn create_worker(&self, owner: &str, input: &Value) -> Result<Value> {
        let configuration = &input["modelConfiguration"];
        let root = self.assert_models(owner, configuration).await?;
        let positions = self
            .database
            .query(
                "SELECT max(position) FROM task_workers WHERE owner_id=$1 AND deleted_at IS NULL",
                &[&owner],
            )
            .await?;
        let position = positions
            .first()
            .map(|r| r.get::<Option<i32>>(0))
            .transpose()?
            .flatten()
            .map_or(-1, i64::from)
            + 1;
        let mut fields = configuration_columns(configuration);
        fields["id"] = json!(uuid::Uuid::new_v4().to_string());
        fields["owner_id"] = json!(owner);
        for (column, key) in [
            ("name", "name"),
            ("enabled", "enabled"),
            ("max_concurrency", "maxConcurrency"),
            ("allows_plan_goal", "allowsPlanGoal"),
            ("continuity_family_override", "continuityFamilyOverride"),
        ] {
            if let Some(value) = input.get(key) {
                fields[column] = value.clone();
            }
        }
        fields["position"] = json!(position);
        fields["continuity_family"] = if let Some(family) = input
            .get("continuityFamilyOverride")
            .filter(|v| !v.is_null())
        {
            family.clone()
        } else {
            self.infer_family(owner, &root).await?
        };
        // Match Drizzle's omission of undefined properties so actual database
        // defaults remain authoritative for internal typed callers as well.
        let columns = fields
            .as_object()
            .unwrap()
            .keys()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let selected = columns
            .iter()
            .map(|column| format!("d.{column}"))
            .collect::<Vec<_>>()
            .join(",");
        let fields = storage(fields).stringify();
        let row=one(Executor::Database(&self.database),&format!("INSERT INTO task_workers({}) SELECT {selected} FROM jsonb_populate_record(NULL::task_workers,$1::text::jsonb) d RETURNING to_jsonb(task_workers)::text",columns.join(",")),&[&fields]).await?.context("Task Worker insert returned no row")?;
        worker_summary(&row, 0)
    }
    pub async fn update_worker(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let Some(current)=one(Executor::Database(&self.database),"SELECT to_jsonb(w)::text FROM task_workers w WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL LIMIT 1",&[&id,&owner]).await?else{return Ok(None)};
        const STALE: &str = "The Task Worker changed before this update was applied.";
        if current["row_version"] != input["rowVersion"] {
            return conflict("stale-version", STALE);
        }
        let configuration = input
            .get("modelConfiguration")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| model_configuration(&current));
        let root = self.assert_models(owner, &configuration).await?;
        let override_family = input
            .get("continuityFamilyOverride")
            .unwrap_or(&current["continuity_family_override"]);
        let family = if truthy(Some(override_family)) {
            override_family.clone()
        } else if truthy(input.get("modelConfiguration"))
            || input.get("continuityFamilyOverride") == Some(&Value::Null)
        {
            self.infer_family(owner, &root).await?
        } else {
            current["continuity_family"].clone()
        };
        let mut fields = configuration_columns(&configuration);
        for (column, key) in [
            ("name", "name"),
            ("enabled", "enabled"),
            ("max_concurrency", "maxConcurrency"),
            ("allows_plan_goal", "allowsPlanGoal"),
        ] {
            if let Some(value) = input.get(key) {
                fields[column] = value.clone();
            }
        }
        fields["continuity_family"] = family;
        fields["continuity_family_override"] = override_family.clone();
        fields["updated_at"] = now();
        let version = input["rowVersion"].stringify();
        let assignments = fields
            .as_object()
            .unwrap()
            .keys()
            .map(|key| format!("{key}=d.{key}"))
            .collect::<Vec<_>>()
            .join(",");
        let fields = storage(fields).stringify();
        let updated=one(Executor::Database(&self.database),&format!("UPDATE task_workers w SET {assignments},row_version=w.row_version+1 FROM jsonb_populate_record(NULL::task_workers,$4::text::jsonb) d WHERE w.id=$1 AND w.owner_id=$2 AND w.row_version=$3::text::integer AND w.deleted_at IS NULL RETURNING to_jsonb(w)::text"),&[&id,&owner,&version,&fields]).await?;
        match updated {
            Some(row) => worker_summary(&row, 0).map(Some),
            None => conflict("stale-version", STALE),
        }
    }
    pub async fn delete_worker(&self, owner: &str, id: &str, version: &Value) -> Result<bool> {
        let at = text(&now())?;
        let version = (!version.is_null()).then(|| version.stringify());
        let deleted=self.database.query("UPDATE task_workers SET enabled=false,deleted_at=$4::text::timestamptz,row_version=row_version+1,updated_at=$4::text::timestamptz WHERE id=$1 AND owner_id=$2 AND row_version=$3::text::integer AND deleted_at IS NULL RETURNING id",&[&id,&owner,&version,&at]).await?;
        if !deleted.is_empty() {
            return Ok(true);
        }
        if !self.database.query("SELECT row_version FROM task_workers WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL LIMIT 1",&[&id,&owner]).await?.is_empty(){return conflict("stale-version","The Task Worker changed before it was removed.");}
        Ok(false)
    }
    pub async fn reorder_workers(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        let list_owner = owner.clone();
        self.database.transaction(|tx|Box::pin(async move{
            let rows=tx.query("SELECT id FROM task_workers WHERE owner_id=$1 AND deleted_at IS NULL",&[&owner]).await?;
            let current=rows.iter().map(|r|r.get::<String>(0)).collect::<Result<HashSet<_>>>()?;let ids=input["ids"].as_array().context("Task Worker ordering")?;
            if current.len()!=ids.len() || ids.iter().any(|id|id.as_str().is_none_or(|id|!current.contains(id))){return conflict("invalid-order","Task Worker ordering must include every current Task Worker once.");}
            tx.query("UPDATE task_workers SET position=position+1000000,updated_at=$2::text::timestamptz WHERE owner_id=$1 AND deleted_at IS NULL",&[&owner,&text(&now())?]).await?;
            for (position,id) in ids.iter().enumerate(){tx.query("UPDATE task_workers SET position=$3,row_version=row_version+1,updated_at=$4::text::timestamptz WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",&[&text(id)?,&owner,&(position as i32),&text(&now())?]).await?;}
            Ok(())
        })).await?;
        self.list_workers(&list_owner).await
    }
}
