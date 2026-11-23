use super::*;
use crate::wire::value::json;
pub(super) async fn persist(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    turns: &[Value],
) -> Result<()> {
    let id = text(&binding["id"])?;
    for turn in turns {
        if turn["threadId"] != binding["threadId"] {
            return reject("turn-thread-mismatch", 409);
        }
        let capture = turn
            .get("modelAttribution")
            .or_else(|| turn.get("usage").and_then(|u| u.get("modelAttribution")));
        if capture
            .is_some_and(|c| c["threadId"] != turn["threadId"] || c["turnId"] != turn["turnId"])
        {
            return reject("turn-thread-mismatch", 409);
        }
        let turn_id = text(&turn["turnId"])?;
        let existing=one(tx,"SELECT to_jsonb(t)::text FROM native_history_turns t WHERE binding_id=$1 AND turn_id=$2",&[&id,&turn_id]).await?;
        let digest = payload_digest(turn);
        if let Some(existing) = &existing {
            let revision = turn["revision"].as_f64().context("History turn revision")?;
            let stored = existing["revision"]
                .as_f64()
                .context("Stored turn revision")?;
            if revision < stored {
                continue;
            }
            if revision == stored {
                if existing["payload_digest"] != json!(digest) {
                    return reject("turn-revision-conflict", 409);
                }
                continue;
            }
            if existing["status"] != "inProgress" && turn["status"] == "inProgress" {
                if existing["captured_model_attribution"].is_null()
                    && let Some(capture) = capture
                {
                    tx.query("UPDATE native_history_turns SET captured_model_attribution=$1::text::jsonb WHERE binding_id=$2 AND turn_id=$3",&[&capture.stringify(),&id,&turn_id]).await?;
                }
                let mut stale = turn.clone();
                stale["status"] = existing["status"].clone();
                stale["startedAtMs"] = existing["started_at_ms"].clone();
                stale["completedAtMs"] = existing["completed_at_ms"].clone();
                usage::record(tx, owner, binding, &stale).await?;
                continue;
            }
        }
        let captured = existing
            .as_ref()
            .map(|e| &e["captured_model_attribution"])
            .filter(|v| !v.is_null())
            .or(capture)
            .cloned()
            .unwrap_or(Value::Null);
        let data = json!({"binding_id":binding["id"],"turn_id":turn["turnId"],"revision":turn["revision"],"ordinal":turn["ordinal"],"status":turn["status"],"started_at_ms":turn["startedAtMs"],"completed_at_ms":turn["completedAtMs"],"metadata":turn["metadata"],"usage":turn.get("usage").cloned().unwrap_or(Value::Null),"model_attribution":turn.get("modelAttribution").cloned().unwrap_or(Value::Null),"captured_model_attribution":captured,"payload_digest":digest});
        let columns = data
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str().unwrap())
            .collect::<Vec<_>>();
        let sql = if existing.is_some() {
            format!(
                "UPDATE native_history_turns target SET {} FROM jsonb_populate_record(NULL::native_history_turns,$1::jsonb) incoming WHERE target.binding_id=incoming.binding_id AND target.turn_id=incoming.turn_id",
                columns
                    .iter()
                    .map(|c| format!("{c}=incoming.{c}"))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        } else {
            format!(
                "INSERT INTO native_history_turns({}) SELECT {} FROM jsonb_populate_record(NULL::native_history_turns,$1::jsonb) incoming",
                columns.join(","),
                columns
                    .iter()
                    .map(|c| format!("incoming.{c}"))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        };
        tx.query(&sql, &[&postgres_types::Json(data)]).await?;
        usage::record(tx, owner, binding, turn).await?;
    }
    Ok(())
}
