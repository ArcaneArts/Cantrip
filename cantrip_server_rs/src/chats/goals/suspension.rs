//! Reuse canonical routing and held managed preparation without launching a Goal.
use super::*;
impl Service {
    pub(in crate::chats) async fn suspended_launch(
        &self,
        owner: &str,
        context: &Value,
    ) -> Result<Option<Value>> {
        let Some(runtime) = self
            .dependencies
            .routing
            .runtime_for_context(owner, context)
            .await?
        else {
            return Ok(None);
        };
        self.dependencies
            .console
            .prepare_turn(owner, context, &runtime)
            .await
            .map(Some)
    }
}
