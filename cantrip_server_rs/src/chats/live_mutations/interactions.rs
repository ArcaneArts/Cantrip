use super::*;
use crate::{agent_interactions, database::Executor, wire::coercion::truthy};
impl Service {
    fn interactions(&self) -> agent_interactions::Repository<'_, '_> {
        agent_interactions::Repository::new(Executor::Database(&self.database))
    }
    fn publish_interaction(self: &Arc<Self>, owner: &str, interaction: &Value) {
        let Some(chat) = interaction["provenance"]["chatId"]
            .as_str()
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let pending =
            self.invalidate_chat(owner, chat, "agent-interaction", &interaction["id"], None);
        self.publish_summary(owner, &json!(chat), &interaction["projectId"]);
        self.fanout(pending.into_iter().collect());
    }
    pub async fn record_interaction(
        self: &Arc<Self>,
        owner: &str,
        input: &Value,
        protected: bool,
    ) -> Result<Value> {
        let result = self.interactions().record(input, protected).await?;
        self.publish_interaction(owner, &result);
        Ok(result)
    }
    pub async fn terminalize_interaction(
        self: &Arc<Self>,
        owner: &str,
        key: &str,
        chat: &str,
        worker: &str,
        status: &str,
        resolution: Option<&Value>,
    ) -> Result<Option<Value>> {
        let result = self
            .interactions()
            .terminalize(key, chat, worker, status, resolution)
            .await?;
        if let Some(result) = &result {
            self.publish_interaction(owner, result)
        }
        Ok(result)
    }
    pub async fn interrupt_interactions(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        lane: Option<&str>,
    ) -> Result<Vec<Value>> {
        let result = self.interactions().interrupt(chat, lane).await?;
        let pending = self.invalidate_chat(owner, chat, "agent-interaction", &Value::Null, None);
        if let Some(project) = result
            .first()
            .map(|v| &v["projectId"])
            .filter(|v| truthy(Some(v)))
        {
            self.publish_summary(owner, &json!(chat), project);
        }
        self.fanout(pending.into_iter().collect());
        Ok(result)
    }
}
