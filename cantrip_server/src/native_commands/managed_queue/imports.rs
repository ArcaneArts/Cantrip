use super::super::CommandError;
use super::*;
use anyhow::Context;
use futures::FutureExt;
const UNBOUND: &[&str] = &["runtimeGeneration", "connectionId"];
async fn renew(tx: &Transaction<'_>, row: &Value, input: &Value) -> Result<()> {
    tx.query("UPDATE managed_queue_imports SET runner_generation=$1,identity=$2::text::jsonb WHERE id=$3",&[&text(&input["runnerGeneration"])?,&input["session"].stringify(),&text(&row["id"])?]).await?;
    Ok(())
}
async fn import(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    authority::authorize(tx, owner, &input["workerId"], &input["session"]).await?;
    let repository = TransactionRepository::new(tx);
    let chat = text(&input["session"]["chatId"])?;
    let worker = text(&input["workerId"])?;
    let mut imported = Vec::<Value>::new();
    for item in input["items"]
        .as_array()
        .context("Native queue import items")?
    {
        if !truthy(item["prompt"].get("protectedNativeInput")) {
            return reject("native-queue-input-required");
        }
        // Hash the original JavaScript key order before SQL JSONB canonicalizes it.
        let source_key = digest(
            &Value::Array(vec![
                json!(owner),
                input["workerId"].clone(),
                normalized(&input["session"], UNBOUND),
                item["nativeItemId"].clone(),
            ])
            .stringify(),
        );
        let id = digest(
            &Value::Array(vec![json!(source_key), item["sourceDigest"].clone()]).stringify(),
        );
        if let Some(existing) = raw_one(
            tx,
            "SELECT to_jsonb(i)::text FROM managed_queue_imports i WHERE id=$1",
            &[&id],
        )
        .await?
        {
            renew(tx, &existing, input).await?;
            imported.push(existing);
            continue;
        }
        let prior = tx
            .query(
                "SELECT to_jsonb(i)::text FROM managed_queue_imports i WHERE source_key=$1",
                &[&source_key],
            )
            .await?
            .iter()
            .map(|r| Ok(serde_json::from_str::<Value>(&r.get::<String>(0)?)?))
            .collect::<Result<Vec<_>>>()?;
        if prior.iter().any(|row| row["status"] != "conflict") {
            return reject("queue-import-conflict");
        }
        let mut replacement = None;
        if let Some(prior) = prior.first() {
            let old = raw_one(
                tx,
                "SELECT to_jsonb(p)::text FROM queued_prompts p WHERE id=$1",
                &[&text(&prior["prompt_id"])?],
            )
            .await?;
            let Some(old) = old.filter(|p| p["state"] == "importing") else {
                return reject("queue-import-conflict");
            };
            replacement = Some(old["position"].clone());
            tx.query(
                "DELETE FROM managed_queue_imports WHERE source_key=$1",
                &[&source_key],
            )
            .await?;
            tx.query(
                "DELETE FROM queued_prompts WHERE id=$1",
                &[&text(&old["id"])?],
            )
            .await?;
        }
        let state = snapshot::snapshot(tx, owner, &chat).boxed().await?;
        let control = repository.control_context(owner, &chat).boxed().await?;
        let mutation = json!({"expectedRevision":state["revision"],"mutation":json!({"kind":"add","prompt":item["prompt"],"attachments":item["attachments"]}),"admission":json!({"workerId":input["workerId"],"operationId":format!("queue-import:{id}"),"origin":"terminal","method":"thread/queue/add","session":input["session"],"payloadDigest":item["sourceDigest"],"protectedPayload":item["prompt"]["protectedNativeInput"],"expectedActivationGeneration":control["activationGeneration"],"intent":json!({"scope":"thread","settingKeys":Vec::<Value>::new(),"expectedTurnId":Value::Null})})});
        let result = repository
            .mutate_queue(owner, &mutation, &Value::object([] as [(&str, Value); 0]))
            .boxed()
            .await?;
        if result["receipt"]["status"] != "applied" {
            return Err(CommandError::new(
                result["receipt"]["rejectionCode"]
                    .as_str()
                    .unwrap_or("queue-import-rejected"),
                None,
                409,
            )
            .into());
        }
        if let Some(position) = replacement {
            tx.query("UPDATE queued_prompts SET state='importing',position=$1::text::integer WHERE id=$2",&[&position.stringify(),&text(&item["prompt"]["id"])?]).await?;
        } else {
            tx.query(
                "UPDATE queued_prompts SET state='importing' WHERE id=$1",
                &[&text(&item["prompt"]["id"])?],
            )
            .await?;
        }
        let created=raw_one(tx,"INSERT INTO managed_queue_imports(id,source_key,source_digest,chat_id,worker_id,native_item_id,protected_source,identity,runner_generation,prompt_id) VALUES($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::text::jsonb,$9,$10) RETURNING to_jsonb(managed_queue_imports)::text",&[&id,&source_key,&text(&item["sourceDigest"])?,&chat,&worker,&text(&item["nativeItemId"])?,&item["protectedSource"].stringify(),&input["session"].stringify(),&text(&input["runnerGeneration"])?,&text(&item["prompt"]["id"])?]).await?.context("Queue import insert")?;
        imported.push(created);
    }
    let outstanding=tx.query("SELECT to_jsonb(i)::text FROM managed_queue_imports i WHERE chat_id=$1 AND worker_id=$2 AND status IN ('pending','uncertain')",&[&chat,&worker]).await?;
    for row in outstanding {
        let row: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        if !deep_equal(
            &normalized(&row["identity"], UNBOUND),
            &normalized(&input["session"], UNBOUND),
        ) {
            continue;
        }
        renew(tx, &row, input).await?;
        if !imported.iter().any(|i| i["id"] == row["id"]) {
            imported.push(row);
        }
    }
    let imports=imported.iter().map(|row|json!({"importId":row["id"],"nativeItemId":row["native_item_id"],"sourceDigest":row["source_digest"],"protectedSource":row["protected_source"],"nativeDeleteOperationId":format!("queue-delete:{}",text(&row["id"]).unwrap()),"promptId":row["prompt_id"],"status":row["status"]})).collect::<Vec<_>>();
    let mut result = snapshot::snapshot(tx, owner, &chat).await?;
    result["imports"] = Value::Array(imports);
    Ok(result)
}
async fn acknowledge(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    authority::authorize(tx, owner, &input["workerId"], &input["session"]).await?;
    let record = raw_one(
        tx,
        "SELECT to_jsonb(i)::text FROM managed_queue_imports i WHERE id=$1",
        &[&text(&input["importId"])?],
    )
    .await?;
    let Some(record) = record.filter(|r| {
        r["chat_id"] == input["session"]["chatId"]
            && r["worker_id"] == input["workerId"]
            && r["source_digest"] == input["sourceDigest"]
            && r["runner_generation"] == input["runnerGeneration"]
            && deep_equal(&r["identity"], &input["session"])
    }) else {
        return reject("stale-queue-import");
    };
    if record["status"] != "imported" {
        let status = if truthy(input["receipt"].get("conflict")) {
            "conflict"
        } else if truthy(input["receipt"].get("deleted")) {
            "imported"
        } else {
            "uncertain"
        };
        if record["status"] != status {
            tx.query(
                "UPDATE managed_queue_imports SET status=$1 WHERE id=$2",
                &[&status, &text(&record["id"])?],
            )
            .await?;
            if status == "imported" {
                tx.query(
                    "UPDATE queued_prompts SET state='pending' WHERE id=$1 AND state='importing'",
                    &[&text(&record["prompt_id"])?],
                )
                .await?;
            }
            bump(tx, &text(&record["chat_id"])?).await?;
        }
    }
    snapshot::snapshot(tx, owner, &text(&input["session"]["chatId"])?).await
}
impl QueueRepository {
    pub async fn import_native(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database
            .transaction(|tx| Box::pin(async move { import(tx, &owner, &input).boxed().await }))
            .await
    }
    pub async fn acknowledge_import(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database
            .transaction(|tx| Box::pin(async move { acknowledge(tx, &owner, &input).await }))
            .await
    }
}
