use super::*;
impl Repository {
    pub async fn get(&self, owner: &str, chat: &str, operation: &str) -> Result<Option<Value>> {
        let row=one(Executor::Database(&self.database),"SELECT to_jsonb(h)::text FROM native_runtime_handoffs h WHERE owner_id=$1 AND chat_id=$2 AND operation_id=$3",&[&owner,&chat,&operation]).await?;
        let Some(mut row) = row else { return Ok(None) };
        if !truthy(row.get("binding"))
            && truthy(row.get("prepared"))
            && matches!(row["phase"].as_str(), Some("committed" | "completed"))
        {
            let state =
                settings_persistence::get(Executor::Database(&self.database), owner, chat).await?;
            if let Some(current) = state
                .as_ref()
                .and_then(|s| s.get("binding"))
                .filter(|b| truthy(Some(b)))
            {
                let mut expected = row["source"].clone();
                expected["bindingId"] = current["bindingId"].clone();
                expected["modelRouteId"] = row["target_model_route_id"].clone();
                expected["providerAccountId"] = row["target_provider_account_id"].clone();
                expected["runtimeGeneration"] = row["prepared"]["runtimeGeneration"].clone();
                expected["nativeEpoch"] =
                    row["prepared"]["snapshot"]["context"]["settingsVersion"]["epoch"].clone();
                if deep_equal(current, &expected) {
                    row["binding"] = current.clone();
                }
            }
        }
        wire(&row).map(Some)
    }
    pub async fn active_for_worker(&self, owner: &str, worker: &str) -> Result<Vec<Value>> {
        self.database.query("SELECT to_jsonb(h)::text FROM native_runtime_handoffs h WHERE owner_id=$1 AND worker_id=$2 AND phase IN ('preparing','prepared','committed')",&[&owner,&worker]).await?.iter().map(|r|wire(&serde_json::from_str(&r.get::<String>(0)?)?)).collect()
    }
    pub async fn begin(&self, owner: &str, chat: &str, input: &Value) -> Result<Value> {
        let input = parse("nativeRuntimeHandoffRequestSchema", input)?;
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            context::lock_chat(tx,&owner,&chat).await?;
            let operation=text(&input["operationId"])?;
            if let Some(row)=one(Executor::Transaction(tx),"SELECT to_jsonb(h)::text FROM native_runtime_handoffs h WHERE operation_id=$1",&[&operation]).await? {
                if row["owner_id"]!=owner||row["chat_id"]!=chat||row["source"].get("bindingId")!=input.get("bindingId")||row.get("target_model_route_id")!=input.get("targetModelRouteId")||row.get("target_provider_account_id")!=input.get("targetProviderAccountId"){return reject("handoff-operation-conflict")}
                return wire(&row)
            }
            crate::chats::guard::assert_runtime_writable(tx,&chat,None,None,crate::chats::guard::Access::Write).await?;
            let state=settings_persistence::get(Executor::Transaction(tx),&owner,&chat).await?;
            let Some(state)=state.filter(|s|truthy(s.get("binding"))&&s["binding"].get("bindingId")==input.get("bindingId"))else{return reject("handoff-source-replaced")};
            let source=&state["binding"];
            guards::assert_source(tx,&owner,source).await?;guards::assert_idle(tx,&chat).await?;
            if !state["pending"].as_array().context("Settings pending operations")?.is_empty(){return reject("handoff-settings-pending")}
            let target=guards::target(tx,&owner,&input["targetModelRouteId"],&input["targetProviderAccountId"]).await?;
            let route=source.get("modelRouteId").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!(""));
            let source_route=one(Executor::Transaction(tx),"SELECT to_jsonb(r)::text FROM model_routes r WHERE id=$1",&[&text(&route)?]).await?;
            if source_route.as_ref().and_then(|r|r.get("provider_id"))==target.get("providerId") && source.get("providerAccountId")==input.get("targetProviderAccountId"){return reject("handoff-same-provider-account")}
            let row=one(Executor::Transaction(tx),"INSERT INTO native_runtime_handoffs(operation_id,owner_id,chat_id,worker_id,source,binding,phase,target_model_route_id,target_provider_account_id) VALUES($1,$2,$3,$4,$5::text::jsonb,$5::text::jsonb,'preparing',$6,$7) RETURNING to_jsonb(native_runtime_handoffs)::text",&[&operation,&owner,&chat,&text(&source["workerId"])?,&source.stringify(),&text(&input["targetModelRouteId"])?,&optional(&input["targetProviderAccountId"])?]).await?.context("Runtime handoff reservation returned no row")?;
            wire(&row)
        })).await
    }
}
