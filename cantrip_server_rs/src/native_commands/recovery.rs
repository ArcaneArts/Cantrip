use super::{
    CommandError, Repository,
    admit::{raw_one, text},
    context, receipt,
};
use crate::wire::{Value, coercion::truthy, value::json};
use anyhow::Result;
use futures::FutureExt;
impl Repository {
    /// Capture the old writer before its worker performs an actual native read.
    pub async fn recovery_context(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            context::lock_chat(tx,&owner,&chat).await?;
            let current=context::execution(tx,&owner,&chat).await?;
            let active=raw_one(tx,"SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",&[&chat]).await?.unwrap_or(Value::Null);
            let Some(current)=current.filter(|c|truthy(active.get("active"))&&truthy(active.get("native_turn_id"))&&truthy(active.get("runtime_generation"))&&active.get("execution_lane_id")==c.get("executionLaneId")) else{return Ok(None);};
            let operation=raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND owner_id=$2",&[&text(&active["operation_id"])?,&owner]).await?;
            let Some(operation)=operation.filter(|o|o["kind"]=="start") else{return Ok(None);};
            Ok(Some(json!({"receipt":receipt::from_row(&operation)?,"threadId":current["threadId"],"turnId":active["native_turn_id"],"runtimeGeneration":active["runtime_generation"]})))
        })).await
    }
    /// Only terminal evidence from a different runtime can settle the captured writer.
    pub async fn recover_execution(
        &self,
        owner: &str,
        worker: &str,
        expected: &Value,
        observed: &Value,
    ) -> Result<bool> {
        if expected.get("threadId") != observed.get("threadId")
            || expected.get("turnId") != observed.get("turnId")
            || expected.get("runtimeGeneration") == observed.get("runtimeGeneration")
            || !truthy(observed.get("status"))
            || observed["status"] == "inProgress"
        {
            return Ok(false);
        }
        let input = json!({"workerId":worker,"operationId":expected["receipt"]["operationId"],"operationGeneration":expected["receipt"]["operationGeneration"],"status":"applied","resultDigest":Value::Null,"protectedResult":Value::Null,"rejectionCode":Value::Null,"executionComplete":true,"executionStatus":if observed["status"]=="failed"{"failed"}else{"idle"},"reconciliation":json!({"nativeTurnId":observed["turnId"],"runtimeGeneration":expected["runtimeGeneration"]})});
        match self.settle(owner, &input).boxed().await {
            Ok(_) => Ok(true),
            Err(error) => {
                if let Some(command) = error.downcast_ref::<CommandError>() {
                    if command.code == "stale-native-evidence" {
                        return Ok(false);
                    }
                    if command.code == "receipt-conflict" {
                        let current = self
                            .control_context(owner, &text(&expected["receipt"]["chatId"])?)
                            .await?;
                        if current.get("activationGeneration")
                            != expected["receipt"].get("activationGeneration")
                        {
                            return Ok(false);
                        }
                    }
                }
                Err(error)
            }
        }
    }
}
