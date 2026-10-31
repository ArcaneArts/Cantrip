use super::{CommandError, Repository, context, receipt};
use crate::{
    database::{Executor, Transaction},
    wire::{self, Value, coercion::truthy},
};
use anyhow::{Context, Result};

async fn bind(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    let text = |value: &Value| {
        value
            .as_js_string()
            .map(|v| v.lossy().into_owned())
            .context("Native command identity")
    };
    let session = &input["session"];
    let chat = text(&session["chatId"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let row = context::read(
        Executor::Transaction(tx),
        owner,
        &text(&input["workerId"])?,
        &text(&input["operationId"])?,
        &text(&input["operationGeneration"])?,
    )
    .await?;
    let current = context::execution(tx, owner, &text(&row["chat_id"])?).await?;
    if row["payload_digest"] != input["payloadDigest"] || row["chat_id"] != session["chatId"] {
        return Err(CommandError::new("operation-id-conflict", None, 409).into());
    }
    if row["kind"] != "start" || row["origin"] != "gui" || row["status"] != "accepted" {
        return Err(CommandError::new("preparation-no-longer-accepted", None, 409).into());
    }
    let mut valid = context::same_placement(current.as_ref(), &input["workerId"], Some(session))?;
    if valid {
        valid = context::same_runtime_route(current.as_ref(), Some(session))?;
    }
    if valid {
        valid = truthy(session.get("threadId"))
            && current.as_ref().unwrap()["threadId"] == session["threadId"];
    }
    if valid {
        for field in [
            "threadId",
            "placementId",
            "projectId",
            "contextKind",
            "modelRouteId",
            "providerAccountId",
        ] {
            if wire::property(row.get("identity"), field)? != session.get(field) {
                valid = false;
                break;
            }
        }
    }
    if valid {
        valid = truthy(session.get("runtimeGeneration")) && truthy(session.get("connectionId"));
    }
    if valid {
        for field in ["runtimeGeneration", "connectionId"] {
            let prior = wire::property(row.get("identity"), field)?;
            if prior != Some(&Value::Null) && prior != session.get(field) {
                valid = false;
                break;
            }
        }
    }
    if !valid {
        return Err(CommandError::new("stale-session", None, 409).into());
    }
    let current = current.as_ref().unwrap();
    let rows = tx
        .query(
            "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
            &[&text(&row["chat_id"])?],
        )
        .await?;
    let activation = rows
        .first()
        .map(|row| Ok::<Value, anyhow::Error>(serde_json::from_str(&row.get::<String>(0)?)?))
        .transpose()?
        .unwrap_or(Value::Null);
    if !truthy(activation.get("active"))
        || activation["generation"] != row["activation_generation"]
        || activation["execution_lane_id"] != current["executionLaneId"]
        || !(current["status"] == "running" || current["status"] == "waiting-for-approval")
        || (!activation["runtime_generation"].is_null()
            && activation["runtime_generation"] != session["runtimeGeneration"])
    {
        return Err(CommandError::new("stale-activation", None, 409).into());
    }
    tx.query(
        "UPDATE native_command_activations SET runtime_generation=$1 WHERE chat_id=$2",
        &[
            &text(&session["runtimeGeneration"])?,
            &text(&row["chat_id"])?,
        ],
    )
    .await?;
    let now = crate::auth::now();
    let identity = session.stringify();
    let operation = text(&row["operation_id"])?;
    let rows = tx
        .query(
            "UPDATE native_commands SET identity=$1::text::jsonb,updated_at=$2 WHERE operation_id=$3 RETURNING to_jsonb(native_commands)::text",
            &[&identity, &now, &operation],
        )
        .await?;
    let row = rows
        .first()
        .context("Cannot read properties of undefined (reading 'chatId')")?;
    receipt::from_row(&serde_json::from_str(&row.get::<String>(0)?)?)
}
impl Repository {
    /// Bind a previously accepted GUI preparation without dispatching its turn.
    pub async fn bind_preparation(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database
            .transaction(|tx| Box::pin(async move { bind(tx, &owner, &input).await }))
            .await
    }
}
