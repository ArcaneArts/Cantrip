use super::*;
impl Repository {
    pub async fn archive_turns(&self, owner: &str, raw: &Value) -> Result<Value> {
        let input =
            crate::settings::parse_response("nativeHistoryTurnArchiveReadSchema", Some(raw))?;
        let owner = owner.to_owned();
        self.database.transaction(|tx|Box::pin(async move{
            let (binding,snapshot)=prepare(tx,&owner,&input).await?;let chat=text(&binding["chatId"])?;let thread=text(&binding["threadId"])?;
            let cursor=input.get("cursor").filter(|v|!v.is_null());let source=cursor.map(|c|text(&c["bindingId"])).transpose()?;let turn=cursor.map(|c|text(&c["turnId"])).transpose()?;
            let limit=input["limit"].as_f64().context("Turn archive page size")?as usize;let count=(limit+1)as i64;
            let rows=all(tx,r#"SELECT jsonb_build_object('worker',b.worker_id,'source',to_jsonb(t))::text FROM native_history_turns t INNER JOIN native_history_bindings b ON b.id=t.binding_id WHERE b.owner_id=$1 AND b.chat_id=$2 AND b.thread_id=$3 AND($4::text IS NULL OR t.binding_id COLLATE "C">$4::text COLLATE "C" OR(t.binding_id COLLATE "C"=$4::text COLLATE "C" AND t.turn_id COLLATE "C">$5::text COLLATE "C")) ORDER BY t.binding_id COLLATE "C" ASC,t.turn_id COLLATE "C" ASC LIMIT $6::bigint"#,&[&owner,&chat,&thread,&source,&turn,&count]).await?;
            let page=&rows[..rows.len().min(limit)];let mut turns=Vec::new();
            for row in page{
                let t=&row["source"];
                let mut turn=json!({"threadId":binding["threadId"],"turnId":t["turn_id"],"revision":t["revision"],"ordinal":t["ordinal"],"status":t["status"],"startedAtMs":t["started_at_ms"],"completedAtMs":t["completed_at_ms"],"metadata":t["metadata"]});
                for (field,column) in [("usage","usage"),("modelAttribution","model_attribution")]{if !t[column].is_null(){turn[field]=t[column].clone();}}
                turns.push(json!({"bindingId":t["binding_id"],"workerId":row["worker"],"turn":turn}));
            }
            let cursor=if rows.len()>limit{let t=&page.last().unwrap()["source"];json!({"snapshotId":snapshot,"bindingId":t["binding_id"],"turnId":t["turn_id"]})}else{Value::Null};
            crate::settings::parse_response("nativeHistoryTurnArchivePageSchema",Some(&json!({"binding":binding,"snapshotId":snapshot,"turns":turns,"nextCursor":cursor})))
        })).await
    }
}
