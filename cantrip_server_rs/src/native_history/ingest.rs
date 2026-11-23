use super::*;
use crate::wire::value::json;

#[derive(Debug)]
pub struct BatchRejection {
    pub rejection: Value,
}
impl std::fmt::Display for BatchRejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Native history request failed: {}.",
            self.rejection["code"]
                .as_str()
                .unwrap_or("batch-rejection-conflict")
        )
    }
}
impl std::error::Error for BatchRejection {}
pub(super) fn receipt(row: &Value) -> Value {
    json!({"committed":true,"streamId":row["stream_id"],"sequence":row["sequence"],"recordId":row["record_id"],"digest":row["digest"],"commitId":row["commit_id"]})
}

impl Repository {
    /// The canonical writer is fixed here. A caller cannot substitute a callback
    /// that acknowledges a stream without storing its protected transcript.
    pub async fn ingest(&self, owner: &str, raw: &Value) -> Result<Value> {
        let input = crate::settings::parse_response("nativeHistoryIngestSchema", Some(raw))?;
        let owner = owner.to_owned();
        let result = self
            .database
            .transaction(|tx| Box::pin(async move { commit(tx, &owner, &input).await }))
            .await?;
        // An immutable rejection must commit before its response becomes an error.
        if result.get("rejected") == Some(&json!(true)) {
            return Err(BatchRejection { rejection: result }.into());
        }
        Ok(result)
    }
}
fn rejection_identity(input: &Value, digest: &str) -> Value {
    let mut identity = input.clone();
    if let Value::Object(fields) = &mut identity {
        fields.shift_remove("batch");
    }
    identity["payloadDigest"] = json!(digest);
    identity
}
async fn read_rejection(
    tx: &Transaction<'_>,
    input: &Value,
    digest: &str,
) -> Result<Option<Value>> {
    let binding = text(&input["bindingId"])?;
    let record = text(&input["recordId"])?;
    let Some(row)=one(tx,"SELECT to_jsonb(r)::text FROM native_history_rejections r WHERE binding_id=$1 AND record_id=$2",&[&binding,&record]).await?else{return Ok(None)};
    let decision = crate::settings::parse_response(
        "nativeHistoryBatchRejectionSchema",
        Some(&row["decision"]),
    )?;
    if row["id"] != decision["rejectionId"]
        || rejection_identity(input, digest)
            .as_object()
            .unwrap()
            .iter()
            .any(|(k, v)| decision.get(k.as_str().unwrap()) != Some(v))
    {
        return reject("batch-rejection-conflict", 409);
    }
    Ok(Some(decision))
}
async fn retain_rejection(
    tx: &Transaction<'_>,
    input: &Value,
    digest: &str,
    code: &str,
) -> Result<Value> {
    let mut decision = rejection_identity(input, digest);
    decision["rejected"] = json!(true);
    decision["rejectionId"] = json!(uuid::Uuid::new_v4().to_string());
    decision["code"] = json!(code);
    let decision =
        crate::settings::parse_response("nativeHistoryBatchRejectionSchema", Some(&decision))?;
    tx.query("INSERT INTO native_history_rejections(id,binding_id,record_id,decision) VALUES($1,$2,$3,$4::text::jsonb)",&[&text(&decision["rejectionId"])?,&text(&input["bindingId"])?,&text(&input["recordId"])?,&decision.stringify()]).await?;
    Ok(decision)
}
async fn commit(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    let digest =
        payload_digest(&json!({"batch":input["batch"],"previousDigest":input["previousDigest"]}));
    let worker = text(&input["workerId"])?;
    let chat = text(&input["chatId"])?;
    let id = text(&input["bindingId"])?;
    let stream = text(&input["streamId"])?;
    let binding = bindings::owned(tx, owner, &worker, &chat, &id).await?;
    let items = input["batch"]["items"]
        .as_array()
        .context("Canonical history items")?;
    let turns = input["batch"]["turns"]
        .as_array()
        .context("Canonical history turns")?;
    if items
        .iter()
        .any(|i| i["identity"]["threadId"] != binding["threadId"])
        || turns.iter().any(|t| t["threadId"] != binding["threadId"])
    {
        return reject("batch-thread-mismatch", 409);
    }
    if let Some(decision) = read_rejection(tx, input, &digest).await? {
        return Ok(decision);
    }
    let existing_stream = one(
        tx,
        "SELECT to_jsonb(s)::text FROM native_history_streams s WHERE binding_id=$1 FOR UPDATE",
        &[&id],
    )
    .await?;
    if existing_stream
        .as_ref()
        .is_some_and(|s| s["id"] != input["streamId"])
    {
        return reject("stream-recovery-required", 409);
    }
    let sequence = input["sequence"].stringify();
    if let Some(existing)=one(tx,"SELECT to_jsonb(r)::text FROM native_history_receipts r WHERE stream_id=$1 AND sequence=$2::text::bigint",&[&stream,&sequence]).await?{
        if existing["record_id"]!=input["recordId"]||existing["digest"]!=input["digest"]||existing["payload_digest"]!=json!(digest){return reject("batch-receipt-conflict",409)}
        return Ok(receipt(&existing));
    }
    let prior = existing_stream
        .as_ref()
        .map(|s| &s["acknowledged_sequence"])
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let previous = existing_stream
        .as_ref()
        .map(|s| s["acknowledged_digest"].clone())
        .unwrap_or(Value::Null);
    if input["sequence"].as_f64() != Some(prior + 1.0) || input["previousDigest"] != previous {
        return reject("batch-sequence-conflict", 409);
    }
    let record = text(&input["recordId"])?;
    if !tx
        .query(
            "SELECT commit_id FROM native_history_receipts WHERE stream_id=$1 AND record_id=$2",
            &[&stream, &record],
        )
        .await?
        .is_empty()
    {
        return reject("batch-record-reused", 409);
    }
    tx.query("SAVEPOINT native_history_attempt", &[]).await?;
    let attempt = async {
        if existing_stream.is_none() {
            tx.query(
                "INSERT INTO native_history_streams(id,binding_id) VALUES($1,$2)",
                &[&stream, &id],
            )
            .await?;
        }
        messages::persist(tx, owner, &binding, items).await?;
        turns::persist(tx, owner, &binding, turns).await?;
        let ids = turns
            .iter()
            .map(|t| t["turnId"].clone())
            .chain(items.iter().map(|i| i["identity"]["turnId"].clone()))
            .collect::<Vec<_>>();
        attribution::persist(tx, owner, &binding, &ids).await
    }
    .await;
    if let Err(error) = attempt {
        tx.query("ROLLBACK TO SAVEPOINT native_history_attempt", &[])
            .await?;
        tx.query("RELEASE SAVEPOINT native_history_attempt", &[])
            .await?;
        if let Some(error) = error
            .downcast_ref::<HistoryError>()
            .filter(|e| matches!(e.code, "item-revision-conflict" | "turn-revision-conflict"))
        {
            return retain_rejection(tx, input, &digest, error.code).await;
        }
        return Err(error);
    }
    tx.query("RELEASE SAVEPOINT native_history_attempt", &[])
        .await?;
    let commit = uuid::Uuid::new_v4().to_string();
    let input_digest = text(&input["digest"])?;
    let previous = optional(&input["previousDigest"])?;
    let batch = input["batch"].stringify();
    tx.query("INSERT INTO native_history_receipts(commit_id,stream_id,sequence,record_id,digest,payload_digest,previous_digest,protected_batch) VALUES($1,$2,$3::text::bigint,$4,$5,$6,$7,$8::text::jsonb)",&[&commit,&stream,&sequence,&record,&input_digest,&digest,&previous,&batch]).await?;
    tx.query("UPDATE native_history_streams SET acknowledged_sequence=$1::text::bigint,acknowledged_digest=$2 WHERE id=$3",&[&sequence,&input_digest,&stream]).await?;
    tx.query(
        "INSERT INTO native_history_publications(commit_id,binding_id) VALUES($1,$2)",
        &[&commit, &id],
    )
    .await?;
    Ok(
        json!({"committed":true,"streamId":input["streamId"],"sequence":input["sequence"],"recordId":input["recordId"],"digest":input["digest"],"commitId":commit}),
    )
}
