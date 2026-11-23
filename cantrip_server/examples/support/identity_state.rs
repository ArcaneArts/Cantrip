//! Actual identity repositories; no production route or worker is substituted.
use super::*;
use cantrip_server::{
    encryption::repository::EncryptionRepository, workers::repository::WorkerRepository,
};

pub async fn run(database: Arc<Database>, request: &Value) -> Result<Value> {
    let auth = AuthRepository::new(database.clone());
    let encryption = EncryptionRepository::new(database.clone());
    let text =
        |key: &str| -> Result<&str> { request[key].as_str().context("Identity fixture field") };
    let serde_input = || -> Result<serde_json::Value> {
        Ok(serde_json::from_str(&request["input"].stringify())?)
    };
    match text("op")? {
        "identity-state-whitelisted" => Ok(Value::from_serialize(
            &auth.whitelisted(text("email")?).await?,
        )),
        "identity-state-rotate-csrf" => Ok(Value::from_serialize(
            &auth.rotate_csrf(text("session")?, text("hash")?).await?,
        )),
        "identity-state-prune-mobile" => {
            auth.prune_mobile(
                chrono::DateTime::parse_from_rfc3339(text("before")?)?.with_timezone(&chrono::Utc),
            )
            .await?;
            Ok(Value::Null)
        }
        "identity-state-active-principal" => Ok(Value::from_serialize(
            &encryption
                .find_worker_principal(text("owner")?, text("worker")?, None)
                .await?,
        )),
        "identity-state-principal-by-id" => Ok(Value::from_serialize(
            &encryption
                .find_worker_principal(text("owner")?, text("worker")?, Some(text("principal")?))
                .await?,
        )),
        "identity-state-replace-principal" => Ok(Value::from_serialize(
            &encryption
                .replace_worker_principal(text("owner")?, text("worker")?, &serde_input()?)
                .await?,
        )),
        "identity-state-online-count" => Ok(Value::from_serialize(
            &WorkerRepository::new(database)
                .list_workers(text("owner")?)
                .await?
                .iter()
                .filter(|row| row["online"] == true)
                .count(),
        )),
        "identity-state-operation-usage" => {
            cantrip_server::settings::repository::SettingsRepository::new(database)
                .record_model_operation_usage(text("owner")?, &request["input"])
                .await?;
            Ok(Value::Null)
        }
        "identity-state-legacy-noops" => {
            // The current Source facade methods are empty. Native startup
            // satisfies them through the same canonical SQL migration chain.
            migrate(&database).await?;
            Ok(Value::Null)
        }
        _ => anyhow::bail!("Unknown identity fixture operation"),
    }
}
