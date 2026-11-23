use super::*;
impl Repository {
    pub async fn archive_batches(&self, owner: &str, raw: &Value) -> Result<Value> {
        let input =
            crate::settings::parse_response("nativeHistoryBatchArchiveReadSchema", Some(raw))?;
        let owner = owner.to_owned();
        self.database.transaction(|tx|Box::pin(async move{
            let (binding,snapshot)=prepare(tx,&owner,&input).await?;let chat=text(&binding["chatId"])?;let thread=text(&binding["threadId"])?;
            let cursor=input.get("cursor").filter(|v|!v.is_null());let stream=cursor.map(|c|text(&c["streamId"])).transpose()?;let sequence=cursor.map(|c|c["sequence"].stringify());
            let limit=input["limit"].as_f64().context("Batch archive page size")?as usize;let count=(limit+1)as i64;
            let rows=all(tx,r#"SELECT jsonb_build_object('binding',b.id,'worker',b.worker_id,'source',to_jsonb(r))::text FROM native_history_receipts r INNER JOIN native_history_streams s ON s.id=r.stream_id INNER JOIN native_history_bindings b ON b.id=s.binding_id WHERE b.owner_id=$1 AND b.chat_id=$2 AND b.thread_id=$3 AND($4::text IS NULL OR r.stream_id COLLATE "C">$4::text COLLATE "C" OR(r.stream_id COLLATE "C"=$4::text COLLATE "C" AND r.sequence>$5::text::bigint)) ORDER BY r.stream_id COLLATE "C" ASC,r.sequence ASC LIMIT $6::bigint"#,&[&owner,&chat,&thread,&stream,&sequence,&count]).await?;
            let page=&rows[..rows.len().min(limit)];let mut batches=Vec::new();
            for row in page{let r=&row["source"];batches.push(json!({"bindingId":row["binding"],"workerId":row["worker"],"receipt":ingest::receipt(r),"payloadDigest":r["payload_digest"],"previousDigest":r["previous_digest"],"batch":r["protected_batch"]}));}
            let cursor=if rows.len()>limit{let r=&page.last().unwrap()["source"];json!({"snapshotId":snapshot,"streamId":r["stream_id"],"sequence":r["sequence"]})}else{Value::Null};
            crate::settings::parse_response("nativeHistoryBatchArchivePageSchema",Some(&json!({"binding":binding,"snapshotId":snapshot,"batches":batches,"nextCursor":cursor})))
        })).await
    }
}
