//! Receipt evidence lives on the canonical input message, not another queue.
use super::*;
fn stale<T>() -> Result<T> {
    Err(crate::task_dispatch::Conflict::stale().into())
}
pub(super) async fn recover(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    n: &Value,
) -> Result<Option<Value>> {
    let chat = text(&n["chatId"])?;
    tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
    let row=one(Executor::Transaction(tx),"SELECT jsonb_build_object('message',to_jsonb(m),'projectId',p.id,'experience',c.experience)::text FROM chat_messages m JOIN chats c ON c.id=m.chat_id JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE m.id=$2 AND m.chat_id=$3 LIMIT 1 FOR UPDATE OF m,c,p",&[&owner,&text(&n["clientMessageId"])?,&chat]).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let m = &row["message"];
    let s = &m["task_goal_input"];
    if s.is_null() || s["receipt"]["operationId"] != n["taskInferenceInputOperationId"] {
        return Ok(None);
    }
    let r = parse("taskInferenceInputReceiptSchema", &s["receipt"])?;
    let f = &n["taskDispatchFence"];
    if f.is_null()
        || row["experience"] != "task"
        || r["kind"] != "goal"
        || s["deferred"] == true
        || r["chatId"] != n["chatId"]
        || r["workerId"] != worker
        || r["clientMessageId"] != n["clientMessageId"]
        || r["worktreeId"] != n["worktreeId"]
        || r["executionLaneId"] != n["executionLaneId"]
        || r["dispatch"]["cycleId"] != f["cycleId"]
        || r["dispatch"]["operationId"] != f["operationId"]
        || r["dispatch"]["fencingToken"] != f["fencingToken"]
        || r["dispatch"]["leaseOwner"] != f["leaseOwner"]
        || m["mode"] != "goal"
        || !matches!(m["role"].as_str(), Some("user" | "system"))
        || m["task_protected_content"].is_null()
        || truthy(m.get("content"))
        || (n["outcome"]["ok"] == true
            && (s["accepted"] != true
                || s["dispatched"] != true
                || s["failedBeforeDispatch"] == true))
    {
        return stale();
    }
    let response_key = format!("assistant:{}", text(&r["clientMessageId"])?);
    let message = if n["outcome"]["ok"] == true {
        parse(
            "taskMessageRelayResultSchema",
            &n["outcome"]["result"]["structuredResult"],
        )
        .ok()
        .filter(|v| v["message"]["idempotencyKey"] == response_key.as_str())
        .map(|v| v["message"].clone())
    } else {
        None
    };
    let ok = n["outcome"]["ok"] == true && message.is_some();
    let failure = if ok {
        Value::Null
    } else {
        let error = if n["outcome"]["ok"] == true {
            json!({"message":"Task Goal outcome omitted its canonical protected response."})
        } else {
            json!({"message":n["outcome"]["error"]})
        };
        json!(super::failure_kind::classify(&error))
    };
    if !s["terminal"].is_null()
        && (s["terminal"]["ok"] != ok || s["terminal"]["failureKind"] != failure)
    {
        return stale();
    }
    let terminal = if !s["terminal"].is_null() {
        s["terminal"].clone()
    } else {
        json!({"ok":ok,"failureKind":failure,"observedAt":now(),"projectedAt":Value::Null,
        "threadId":if n["outcome"]["ok"]==true{n["outcome"]["result"]["threadId"].clone()}else{Value::Null},
        "turnId":if n["outcome"]["ok"]==true{n["outcome"]["result"]["turnId"].clone()}else{n["outcome"]["inference"]["turnId"].clone()}})
    };
    let root=one(Executor::Transaction(tx),"SELECT jsonb_build_object('id',w.id)::text FROM project_worktrees w JOIN projects p ON p.id=w.project_id AND p.owner_id=$1 WHERE w.id=$2 LIMIT 1",&[&owner,&text(&r["worktreeId"])?]).await?;
    let root = root
        .as_ref()
        .map(|r| r["id"].clone())
        .unwrap_or_else(|| m["worktree_id"].clone());
    if root.is_null() {
        return stale();
    }
    let saved = if let Some(message) = message {
        Some(
            crate::chats::message_writes::append_task_history_with(
                Executor::Transaction(tx),
                owner,
                &chat,
                &message,
                &json!({"executionLaneId":r["executionLaneId"],"worktreeId":root}),
            )
            .await?
            .ok_or_else(crate::task_dispatch::Conflict::stale)?,
        )
    } else {
        None
    };
    let mut state = s.clone();
    state["terminal"] = terminal.clone();
    tx.query(
        "UPDATE chat_messages SET task_goal_input=$1::text::jsonb WHERE id=$2 AND chat_id=$3",
        &[&state.stringify(), &text(&r["clientMessageId"])?, &chat],
    )
    .await?;
    Ok(Some(
        json!({"receipt":r,"terminal":terminal,"message":saved,"finished":false,"historyOnly":true,"chat":json!({"projectId":row["projectId"],"experience":"task"})}),
    ))
}
