use super::super::CommandError;
use super::*;
pub(super) fn method(kind: &Value) -> Option<&'static str> {
    match kind.as_str()? {
        "add" => Some("thread/queue/add"),
        "update" => Some("thread/queue/update"),
        "delete" => Some("thread/queue/delete"),
        "reorder" => Some("thread/queue/reorder"),
        "start" => Some("thread/queue/start"),
        _ => None,
    }
}
pub(super) async fn result(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    row: &Value,
) -> Result<Value> {
    let mut result = snapshot::snapshot(tx, owner, chat).await?;
    result["receipt"] = TransactionRepository::new(tx)
        .get(
            owner,
            &text(&row["worker_id"])?,
            &text(&row["operation_id"])?,
            &text(&row["operation_generation"])?,
        )
        .await?;
    if truthy(row["queue_result"].get("acceptedItem")) {
        result["acceptedItem"] = row["queue_result"]["acceptedItem"].clone();
    }
    Ok(result)
}
pub(super) async fn prior(
    tx: &Transaction<'_>,
    owner: &str,
    admission: &Value,
    current_read: bool,
) -> Result<Option<Value>> {
    let id = text(&admission["operationId"])?;
    let Some(row) = raw_one(
        tx,
        "SELECT to_jsonb(c)::text FROM native_commands c WHERE operation_id=$1",
        &[&id],
    )
    .await?
    else {
        return Ok(None);
    };
    let fields = if current_read {
        &[
            "connectionId",
            "runtimeGeneration",
            "modelRouteId",
            "providerAccountId",
        ][..]
    } else {
        &["connectionId", "runtimeGeneration"][..]
    };
    if row["owner_id"] != owner
        || row["worker_id"] != admission["workerId"]
        || row["chat_id"] != admission["session"]["chatId"]
        || row["method"] != admission["method"]
        || row["payload_digest"] != admission["payloadDigest"]
        || !deep_equal(
            &normalized(&row["identity"], fields),
            &normalized(&admission["session"], fields),
        )
    {
        return reject("operation-id-conflict");
    }
    let claim = raw_one(
        tx,
        "SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE request_operation_id=$1",
        &[&id],
    )
    .await?;
    let mut result = result(tx, owner, &text(&admission["session"]["chatId"])?, &row).await?;
    if let Some(claim) = claim {
        result["claim"] = claim_value(&claim)?;
    }
    Ok(Some(result))
}
impl QueueRepository {
    pub async fn gui_operation(&self, owner: &str, chat: &str, id: &str) -> Result<Value> {
        let (owner, chat, id) = (owner.to_owned(), chat.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move{
            authority::lock(tx,&owner,&chat).await?;
            let Some(row)=raw_one(tx,"SELECT to_jsonb(c)::text FROM native_commands c WHERE operation_id=$1 AND owner_id=$2 AND chat_id=$3 AND origin='gui' AND method IN ('thread/queue/add','thread/queue/update','thread/queue/delete','thread/queue/reorder')",&[&id,&owner,&chat]).await? else{return Ok(json!({"found":false}))};
            let mut result=result(tx,&owner,&chat,&row).await?;
            result["found"]=json!(true);
            Ok(result)
        })).await
    }
    pub async fn lookup(&self, owner: &str, admission: &Value) -> Result<Value> {
        let (owner, admission) = (owner.to_owned(), admission.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    authority::authorize(tx, &owner, &admission["workerId"], &admission["session"])
                        .await?;
                    if !["add", "update", "delete", "reorder", "start"]
                        .iter()
                        .any(|k| method(&json!(*k)).is_some_and(|m| admission["method"] == m))
                    {
                        return reject("queue-method-mismatch");
                    }
                    if let Some(mut result) = prior(tx, &owner, &admission, true).await? {
                        result["found"] = json!(true);
                        Ok(result)
                    } else {
                        Ok(json!({"found":false}))
                    }
                })
            })
            .await
    }
    pub async fn start_receipt(
        &self,
        owner: &str,
        worker: &Value,
        session: &Value,
        id: &str,
    ) -> Result<Option<Value>> {
        let (owner, worker, session, id) = (
            owner.to_owned(),
            worker.clone(),
            session.clone(),
            id.to_owned(),
        );
        self.database.transaction(|tx|Box::pin(async move{
            let chat=text(&session["chatId"])?;
            authority::lock(tx,&owner,&chat).await?;
            let Some(claim)=raw_one(tx,"SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE id=$1 AND chat_id=$2",&[&id,&chat]).await? else{return reject("queue-claim-not-found")};
            if truthy(claim.get("request_operation_id")) {
                let request=raw_one(tx,"SELECT to_jsonb(c)::text FROM native_commands c WHERE operation_id=$1 AND owner_id=$2 AND worker_id=$3",&[&text(&claim["request_operation_id"])?,&owner,&text(&worker)?]).await?;
                let Some(request)=request else{return reject("stale-queue-session")};
                let original=normalized(&request["identity"],&["connectionId","runtimeGeneration"]);
                let current=normalized(&session,&["connectionId","runtimeGeneration"]);
                if !deep_equal(&original,&current) {
                    authority::authorize(tx,&owner,&worker,&session).await?;
                    if !deep_equal(&normalized(&original,&["modelRouteId","providerAccountId"]),&normalized(&current,&["modelRouteId","providerAccountId"])) {return reject("stale-queue-session")}
                }
            } else {authority::authorize(tx,&owner,&worker,&session).await?;}
            if !truthy(claim.get("operation_id")) || !truthy(claim.get("operation_generation")) {
                if claim["status"]=="rejected" {return reject("queue-claim-rejected")}
                return Ok(None);
            }
            let operation=raw_one(tx,"SELECT to_jsonb(c)::text FROM native_commands c WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND chat_id=$4",&[&text(&claim["operation_id"])?,&text(&claim["operation_generation"])?,&owner,&chat]).await?;
            let Some(operation)=operation else{return reject("stale-queue-claim")};
            if claim["status"]=="rejected" && !(truthy(claim.get("awaiting_goal")) && operation["status"]=="applied") {return reject("queue-claim-rejected")}
            if operation["status"]=="rejected" {return Err(CommandError::new(operation["rejection_code"].as_str().unwrap_or("queue-claim-rejected"),None,409).into())}
            if operation["status"]=="uncertain" {return reject("queue-dispatch-uncertain")}
            if operation["status"]!="applied" || !truthy(operation.get("protected_result")) || !truthy(operation.get("result_digest")) {return Ok(None)}
            let receipt=TransactionRepository::new(tx).get(&owner,&text(&operation["worker_id"])?,&text(&operation["operation_id"])?,&text(&operation["operation_generation"])?).await?;
            Ok(Some(json!({"claim":claim_value(&claim)?,"receipt":receipt,"protectedResult":operation["protected_result"],"resultDigest":operation["result_digest"]})))
        })).await
    }
}
