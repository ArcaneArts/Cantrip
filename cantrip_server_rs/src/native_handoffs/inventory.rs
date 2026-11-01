use super::*;
impl Repository {
    pub async fn inventory(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let latest=self.database.query("SELECT operation_id FROM native_runtime_handoffs WHERE owner_id=$1 AND chat_id=$2 ORDER BY created_at DESC,operation_id DESC LIMIT 1",&[&owner,&chat]).await?;
        let latest = match latest.first() {
            Some(row) => self.get(owner, chat, &row.get::<String>(0)?).await?,
            None => None,
        };
        if self
            .database
            .query(
                "SELECT id FROM chats WHERE id=$1 AND owner_id=$2",
                &[&chat, &owner],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let state =
            settings_persistence::get(Executor::Database(&self.database), owner, chat).await?;
        let rows=self.database.query("SELECT jsonb_build_object('providerId',p.id,'providerName',p.name,'kind',p.kind,'routeId',r.id,'name',r.model_name,'profileName',m.name)::text FROM model_routes r INNER JOIN model_providers p ON p.id=r.provider_id INNER JOIN model_profiles m ON m.id=r.model_id WHERE p.owner_id=$1 AND m.owner_id=$1 AND r.enabled=true ORDER BY p.name ASC,m.name ASC,r.position ASC",&[&owner]).await?;
        let rows = rows
            .iter()
            .map(|r| Ok(serde_json::from_str::<Value>(&r.get::<String>(0)?)?))
            .collect::<Result<Vec<_>>>()?;
        let accounts = crate::settings::repository::SettingsRepository::new(self.database.clone());
        let mut providers = Vec::<Value>::new();
        for row in &rows {
            if providers
                .iter()
                .any(|p| p.get("id") == row.get("providerId"))
            {
                continue;
            }
            let requires = matches!(row["kind"].as_str(), Some("chatgpt" | "grok"));
            let available = if requires {
                accounts
                    .list_provider_accounts(owner, &text(&row["providerId"])?)
                    .await?
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|a| a["enabled"] == true)
                    .map(|v| Value::from_serialize(&v))
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let models=rows.iter().filter(|m|m.get("providerId")==row.get("providerId")).map(|m|json!({"routeId":m["routeId"],"name":m["name"],"profileName":m["profileName"]})).collect::<Vec<_>>();
            providers.push(json!({"id":row["providerId"],"name":row["providerName"],"requiresAccount":requires,"accounts":available,"models":models}));
        }
        parse("nativeRuntimeHandoffInventorySchema",&json!({"chatId":chat,"binding":state.as_ref().map(|s|&s["binding"]),"latest":latest,"providers":providers})).map(Some)
    }
}
