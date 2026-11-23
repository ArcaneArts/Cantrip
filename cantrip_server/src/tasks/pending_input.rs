//! A lost relay RPC is not a terminal native Task outcome.
use super::*;

impl Repository {
    pub async fn pending_input_after_transport_loss(
        &self,
        owner: &str,
        chat: &str,
        fence: &Value,
    ) -> Result<bool> {
        let (owner, chat, fence) = (owner.to_owned(), chat.to_owned(), fence.clone());
        self.database.transaction(|tx| Box::pin(async move {
            let operation = text(&fence["operationId"])?;
            let guard = json!({"kind":"leased","lease":fence});
            dispatch_fence::assert(tx, &owner, &chat, &operation, &guard, false).await?;
            let round = one(Executor::Transaction(tx),
                "SELECT to_jsonb(r)::text FROM task_planning_rounds r WHERE id=$1 AND chat_id=$2 LIMIT 1 FOR UPDATE",
                &[&operation, &chat]).await?;
            let Some(round) = round else { return Ok(false); };
            let state = &round["inference_input"];
            if state.is_null() || state["deferred"] == true || !state["terminal"].is_null()
                || (state["failedBeforeDispatch"] == true && state["firstDispatchedOperationId"].is_null()) {
                return Ok(false);
            }
            let receipt = &resumption::physical(state)["receipt"];
            if receipt["dispatch"]["cycleId"] != fence["cycleId"]
                || receipt["dispatch"]["operationId"] != fence["operationId"]
                || receipt["dispatch"]["fencingToken"] != fence["fencingToken"]
                || receipt["dispatch"]["leaseOwner"] != fence["leaseOwner"] {
                return Ok(false);
            }
            inference_inputs::context(tx, &owner, &state["receipt"]).await?;
            Ok(true)
        })).await
    }
}
