//! Reuse canonical routing and held managed preparation without launching a Goal.
use super::*;
impl Service {
    pub(in crate::chats) async fn suspended_launch(
        &self,
        owner: &str,
        context: &Value,
    ) -> Result<Option<Value>> {
        let routing = &self.dependencies.routing;
        let runtime = if context.get("councilAgent").is_some()
            && crate::native_commands::Repository::new(self.dependencies.database.clone())
                .council_live_checkpoint_source(owner, &text(&context["chatId"])?)
                .await?
                .is_some()
        {
            Some(routing.bound_managed_runtime(owner, context).await?)
        } else {
            routing.runtime_for_context(owner, context).await?
        };
        let Some(runtime) = runtime else {
            return Ok(None);
        };
        self.dependencies
            .console
            .prepare_turn(owner, context, &runtime)
            .await
            .map(Some)
    }
}
