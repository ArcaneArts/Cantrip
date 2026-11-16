//! Development-only content oracle. All inputs and outputs must be synthetic;
//! never use real profiles, provider credentials, MCP secrets or attachment data.
use anyhow::{Result, anyhow};
use cantrip_crypto::{DecryptionError, content::*, decode, encode};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    encryption::{Identity, Service},
    protected_secrets as worker,
};
use std::{
    io::{self, BufRead},
    sync::Arc,
};
fn operate(input: &Value, service: Option<&Arc<Service>>) -> Result<Value> {
    let key = || decode(input["key"].as_str().unwrap());
    let data = || decode(input["bytes"].as_str().unwrap());
    let context = &input["context"];
    let schema = || input["schema"].as_str().unwrap();
    let maximum = input["maximum"].as_u64().map(|n| n as usize);
    let service = || service.ok_or_else(|| anyhow!("Content fixture service not open"));
    match input["op"].as_str().unwrap_or("") {
        "secret-aad" => secret_associated_data(context),
        "endpoint-aad" => endpoint_associated_data(context),
        "label-aad" => private_label_associated_data(context),
        "metadata-aad" => attachment_metadata_associated_data(context),
        "secret-encrypt" => encrypt_secret(&key()?, context, &input["content"], schema(), maximum),
        "secret-decrypt" => {
            decrypt_secret(&key()?, context, &input["encrypted"], schema(), maximum)
        }
        "endpoint-encrypt" => encrypt_endpoint(&key()?, context, &data()?),
        "endpoint-decrypt" => Ok(json!(encode(&decrypt_endpoint(
            &key()?,
            context,
            &input["encrypted"]
        )?))),
        "label-encrypt" => encrypt_private_label(&key()?, context, &input["label"]),
        "label-decrypt" => decrypt_private_label(&key()?, context, &input["encrypted"]),
        "metadata-encrypt" => encrypt_attachment_metadata(&key()?, context, &input["content"]),
        "metadata-decrypt" => decrypt_attachment_metadata(&key()?, context, &input["encrypted"]),
        "chunk-encrypt" => encrypt_attachment_chunk(&key()?, context, &data()?),
        "chunk-decrypt" => Ok(json!(encode(&decrypt_attachment_chunk(
            &key()?,
            context,
            &input["encrypted"]
        )?))),
        "digest" => Ok(json!(attachment_digest(&data()?))),
        "validate" => cantrip_crypto::checked(schema(), &input["content"]),
        "accept" => Ok(service()?.accept_bootstrap(&input["payload"])?),
        "provider-open-runtime" => worker::open_runtime_provider(service()?, &input["provider"]),
        "provider-protect" => worker::protect_provider_credential(
            service()?,
            &input["accountId"],
            &input["credential"],
        ),
        "provider-open" => {
            worker::open_provider_credential(service()?, &input["accountId"], &input["credential"])
        }
        "provider-subject" => Ok(json!(worker::provider_subject_blind_index(
            service()?,
            &input["credential"]
        )?)),
        "mcp-protect" => {
            worker::protect_discovered_mcp(service()?, &input["workerId"], &input["configuration"])
        }
        "mcp-open" => Ok(json!(worker::open_mcp_servers(
            service()?,
            input["servers"].as_array().unwrap()
        )?)),
        _ => Err(anyhow!("Unknown content fixture operation")),
    }
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    let mut service: Option<Arc<Service>> = None;
    for line in io::stdin().lock().lines() {
        let input = parse_json_text(&line?).map_err(|e| anyhow!("{}", e.lossy()))?;
        let result = if input["op"] == "open-service" {
            if let Some(service) = service.take() {
                service.close().await?;
            }
            let identity = Identity::open(
                std::path::Path::new(input["directory"].as_str().unwrap()),
                input["serverUrl"].as_str().unwrap(),
                input["workerId"].as_js_string().unwrap(),
                false,
            )?;
            let created = Service::new(
                identity,
                input["serverUrl"].as_str().unwrap(),
                cantrip_worker::http::client()?,
            )?;
            let registration = created.registration();
            service = Some(created);
            Ok(registration)
        } else {
            operate(&input, service.as_ref())
        };
        let result = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => {
                json!({"ok":false,"error":error.to_string(),"decryption":error.is::<DecryptionError>()})
            }
        };
        println!(
            "{}",
            json!({"id":input["requestId"],"result":result}).stringify()
        );
    }
    if let Some(service) = service {
        service.close().await?;
    }
    Ok(())
}
