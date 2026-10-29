use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    tunnels::{CreateAttachment, Repository, StopFence, Time},
    wire::Value,
};
use std::sync::Arc;
fn text(v: &Value, key: &str) -> Result<String> {
    Ok(v[key]
        .as_js_string()
        .with_context(|| format!("Fixture tunnel {key}"))?
        .lossy()
        .into_owned())
}
fn date(v: &Value, key: &str) -> Option<Time> {
    v[key]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.with_timezone(&chrono::Utc))
}
pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let now = date(request, "now").context("Fixture tunnel clock")?;
    let repo = if request["realClock"] == true {
        Repository::new(database)
    } else {
        Repository::with_clock(database, Arc::new(move || now))
    };
    let owner = text(request, "owner")?;
    let id = request["attachment"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let result = match request["op"].as_str().context("Fixture operation")? {
        "tunnel-list" => Some(Value::Array(
            repo.list(&owner, request["project"].as_str()).await?,
        )),
        "tunnel-get" => repo.get(&owner, &text(request, "tunnel")?).await?,
        "tunnel-create" => repo.create_user(&owner, &request["input"]).await?,
        "tunnel-update" => {
            repo.update_user(&owner, &text(request, "tunnel")?, &request["input"])
                .await?
        }
        "tunnel-delete" => Some(Value::Bool(
            repo.delete_user(&owner, &text(request, "tunnel")?).await?,
        )),
        "tunnel-managed-register" => {
            repo.register_managed(
                &owner,
                &request["input"],
                request.get("protected").filter(|v| !v.is_null()),
            )
            .await?
        }
        "tunnel-managed-get" => repo.get_managed(&owner, &request["managedBy"]).await?,
        "tunnel-managed-remove" => Some(Value::Bool(
            repo.remove_managed(&owner, &request["managedBy"]).await?,
        )),
        "tunnel-attachment-get" => repo.attachment(&owner, &id).await?,
        "tunnel-attachment-authorize" => {
            repo.authorize_attachment(&id, &text(request, "hash")?)
                .await?
        }
        "tunnel-attachment-create" => {
            let v = &request["input"];
            repo.create_attachment(
                &owner,
                &text(request, "tunnel")?,
                CreateAttachment {
                    client: text(v, "clientId")?,
                    expires: date(v, "expiresAt").context("Attachment expiry")?,
                    secret_expires: date(v, "secretExpiresAt")
                        .context("Attachment secret expiry")?,
                    secret_hash: text(v, "secretHash")?,
                },
            )
            .await?
        }
        "tunnel-attachment-activate" => repo
            .activate_attachment(
                &id,
                &text(request, "client")?,
                date(request, "secret").context("Secret date")?,
            )
            .await?
            .map(|v| {
                Value::String(
                    v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                        .into(),
                )
            }),
        "tunnel-attachment-offline" => Some(Value::Bool(
            repo.mark_offline(
                &id,
                date(request, "secret").context("Secret date")?,
                date(request, "activated").context("Activation date")?,
            )
            .await?,
        )),
        "tunnel-attachment-stop" => {
            let expected = request
                .get("expected")
                .filter(|v| !v.is_null())
                .map(|v| StopFence {
                    activated: date(v, "activatedAt"),
                    expires: date(v, "expiresAt"),
                    secret_expires: date(v, "secretExpiresAt"),
                });
            let error = request["error"]
                .as_js_string()
                .map(|s| s.lossy().into_owned());
            repo.stop_attachment(
                &owner,
                &id,
                error.as_deref(),
                request["preserve"] == true,
                expected,
            )
            .await?
        }
        "tunnel-direct-activate" => {
            repo.activate_direct(
                &owner,
                &id,
                &text(request, "capability")?,
                date(request, "expires"),
                date(request, "secret"),
            )
            .await?
        }
        "tunnel-direct-renew" => {
            repo.renew_direct(
                &owner,
                &id,
                &text(request, "capability")?,
                date(request, "expires"),
            )
            .await?
        }
        "tunnel-direct-finalize" => {
            repo.finalize_direct(
                &owner,
                &id,
                &text(request, "capability")?,
                date(request, "expires"),
            )
            .await?
        }
        "tunnel-direct-expire" => Some(Value::Array(
            repo.expire_direct(date(request, "at").unwrap_or(now))
                .await?,
        )),
        "tunnel-attachment-expire" => Some(Value::Array(
            repo.expire_attachments(date(request, "at").unwrap_or(now))
                .await?,
        )),
        "tunnel-reset" => {
            repo.reset_transient().await?;
            None
        }
        _ => anyhow::bail!("Unsupported tunnel fixture operation"),
    };
    Ok(result.unwrap_or(Value::Null))
}
