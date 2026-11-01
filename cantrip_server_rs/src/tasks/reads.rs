use super::*;
impl Repository {
    pub async fn get(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let ex = Executor::Database(&self.database);
        let Some(task) = owned(ex, owner, chat, false).await? else {
            return Ok(None);
        };
        let cycle = one(ex,"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.chat_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 1",&[&chat]).await?;
        summary(&task, cycle.as_ref()).map(Some)
    }
    pub async fn list(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        let rows = self.database.query("SELECT to_jsonb(t)::text FROM tasks t JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id WHERE p.owner_id=$1 AND c.project_id=$2 AND c.archived_at IS NULL ORDER BY t.created_at DESC,t.chat_id DESC",&[&owner,&project]).await?;
        let tasks = rows
            .iter()
            .map(|r| Ok(serde_json::from_str::<Value>(&r.get::<String>(0)?)?))
            .collect::<Result<Vec<_>>>()?;
        if tasks.is_empty() {
            return Ok(vec![]);
        }
        let ids = json!(
            tasks
                .iter()
                .map(|t| t["chat_id"].clone())
                .collect::<Vec<_>>()
        )
        .stringify();
        let cycles = self.database.query("SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.chat_id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY c.created_at DESC,c.id DESC",&[&ids]).await?.iter().map(|r|Ok(serde_json::from_str::<Value>(&r.get::<String>(0)?)?)).collect::<Result<Vec<_>>>()?;
        tasks
            .iter()
            .map(|t| summary(t, cycles.iter().find(|c| c["chat_id"] == t["chat_id"])))
            .collect()
    }
    pub async fn list_rounds(&self, owner: &str, chat: &str) -> Result<Vec<Value>> {
        if self.get(owner, chat).await?.is_none() {
            return Ok(vec![]);
        }
        self.database.query("SELECT to_jsonb(r)::text FROM task_planning_rounds r WHERE r.chat_id=$1 ORDER BY r.ordinal ASC",&[&chat]).await?.iter().map(|r|round_summary(&serde_json::from_str(&r.get::<String>(0)?)?)).collect()
    }
    pub async fn get_operation_context(
        &self,
        owner: &str,
        chat: &str,
        lookup: &Value,
    ) -> Result<Option<Value>> {
        let filter = [
            ("operationId", "id"),
            ("userMessageId", "user_message_id"),
            ("executionLaneId", "execution_lane_id"),
        ]
        .into_iter()
        .find(|(k, _)| truthy(lookup.get(k)));
        let selected = filter.map(|(k, _)| text(&lookup[k])).transpose()?;
        let extra = filter
            .map(|(_, column)| format!(" AND r.{column}=$3"))
            .unwrap_or_default();
        let sql = format!(
            "SELECT json_build_object('task',to_jsonb(t),'round',to_jsonb(r))::text FROM tasks t JOIN task_planning_rounds r ON r.chat_id=t.chat_id JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id WHERE p.owner_id=$1 AND r.chat_id=$2{extra} ORDER BY r.ordinal ASC"
        );
        let rows = if let Some(selected) = selected {
            self.database
                .query(&sql, &[&owner, &chat, &selected])
                .await?
        } else {
            self.database.query(&sql, &[&owner, &chat]).await?
        };
        // Source chooses the final row whenever the lane key is present, even
        // when a higher-priority operation/message filter selected the rows.
        let row = if truthy(lookup.get("executionLaneId")) {
            rows.last()
        } else {
            rows.first()
        };
        row.map(|r| {
            let data: Value = serde_json::from_str(&r.get::<String>(0)?)?;
            context(&data["task"], &data["round"])
        })
        .transpose()
    }
    pub async fn attach_operation_execution(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        if self.get(owner, chat).await?.is_none() {
            return Ok(None);
        }
        self.database.query("UPDATE task_planning_rounds SET execution_lane_id=$3,user_message_id=$4 WHERE id=$1 AND chat_id=$2",&[&operation,&chat,&nullable_text(&input["executionLaneId"])?,&nullable_text(&input["userMessageId"])?]).await?;
        self.get_operation_context(owner, chat, &json!({"operationId":operation}))
            .await
    }
    pub async fn attach_operation_assistant_message(
        &self,
        owner: &str,
        chat: &str,
        operation: &str,
        message: &str,
    ) -> Result<Option<Value>> {
        if self.get(owner, chat).await?.is_none() {
            return Ok(None);
        }
        self.database.query("UPDATE task_planning_rounds SET assistant_message_id=$3 WHERE id=$1 AND chat_id=$2",&[&operation,&chat,&message]).await?;
        self.get_operation_context(owner, chat, &json!({"operationId":operation}))
            .await
    }
    pub async fn delete_owned(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            if !lock_user(tx,&owner).await? { return Ok(None); }
            let row=tx.query("SELECT c.project_id FROM tasks t JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id WHERE p.owner_id=$1 AND t.chat_id=$2 AND c.archived_at IS NULL LIMIT 1 FOR UPDATE",&[&owner,&chat]).await?;
            let Some(row)=row.first() else { return Ok(None); };
            let project=row.get::<String>(0)?;
            crate::project_layout::detach_resource(tx,&project,"chat",&chat).await?;
            tx.query("DELETE FROM chats WHERE id=$1 AND owner_id=$2 AND experience='task'",&[&chat,&owner]).await?;
            Ok(Some(json!({"projectId":project})))
        })).await
    }
    pub async fn resume_finalization_goal_launch(
        &self,
        owner: &str,
        chat: &str,
    ) -> Result<Option<Value>> {
        let lookup = self
            .get(owner, chat)
            .await?
            .and_then(|t| t.get("activeOperationId").cloned())
            .map(|id| json!({"operationId":id}))
            .unwrap_or_else(|| Value::object([] as [(&str, Value); 0]));
        self.get_operation_context(owner, chat, &lookup).await
    }
}
fn nullable_text(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}

pub fn find_operation_round<'a>(rounds: &'a [Value], lookup: &Value) -> Option<&'a Value> {
    if truthy(lookup.get("operationId")) {
        return rounds.iter().find(|r| r["id"] == lookup["operationId"]);
    }
    if truthy(lookup.get("userMessageId")) {
        return rounds
            .iter()
            .find(|r| r["userMessageId"] == lookup["userMessageId"]);
    }
    if truthy(lookup.get("executionLaneId")) {
        return rounds
            .iter()
            .rev()
            .find(|r| r["executionLaneId"] == lookup["executionLaneId"]);
    }
    None
}
