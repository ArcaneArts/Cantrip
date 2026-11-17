//! Development-only content oracle. All inputs and outputs must be synthetic;
//! never use real profiles, provider credentials, MCP secrets or attachment data.
use anyhow::{Result, anyhow};
use cantrip_crypto::{DecryptionError, content::*, decode, encode};
use cantrip_wire::{Value, parse_json_text, value::json};
use cantrip_worker::{
    encryption::{Identity, Service},
    protected_content as streams, protected_secrets as worker,
};
use std::{
    io::{self, BufRead},
    sync::Arc,
};
fn operate(
    input: &Value,
    service: Option<&Arc<Service>>,
    replay: &mut streams::SurfaceStreamReplayGuard,
) -> Result<Value> {
    let key = || decode(input["key"].as_str().unwrap());
    let data = || decode(input["bytes"].as_str().unwrap());
    let context = &input["context"];
    let schema = || input["schema"].as_str().unwrap();
    let maximum = input["maximum"].as_u64().map(|n| n as usize);
    let service = || service.ok_or_else(|| anyhow!("Content fixture service not open"));
    match input["op"].as_str().unwrap_or("") {
        "secret-aad" => secret_associated_data(context),
        "endpoint-aad" => endpoint_associated_data(context),
        "surface-aad" => surface_stream_associated_data(context),
        "remote-aad" => remote_stream_associated_data(context),
        "surface-encrypt" => encrypt_surface_stream(&key()?, context, &data()?),
        "surface-decrypt" => Ok(json!(encode(&decrypt_surface_stream(
            &key()?,
            context,
            &input["encrypted"]
        )?))),
        "remote-encrypt" => Ok(json!(encode(&encrypt_remote_stream(
            &key()?,
            context,
            &data()?
        )?))),
        "remote-decrypt" => Ok(json!(encode(&decrypt_remote_stream(
            &key()?,
            context,
            &data()?
        )?))),
        "tunnel-seal" => {
            let protected =
                seal_tunnel_data_frame(&input["configuration"], &input["header"], &data()?)?;
            Ok(json!({"header":protected.header,"payload":encode(&protected.payload)}))
        }
        "tunnel-open" => Ok(json!(encode(&open_tunnel_data_frame(
            &input["configuration"],
            &input["header"],
            &data()?
        )?))),
        "remote-encode" => Ok(json!(encode(
            &cantrip_framing::remote_surface::encode_protected_payload(
                cantrip_framing::remote_surface::ProtectedPayload {
                    key_revision: input["keyRevision"].as_u64().unwrap(),
                    nonce: &decode(input["nonce"].as_str().unwrap())?,
                    ciphertext: &data()?
                }
            )?
        ))),
        "remote-decode" => {
            let bytes = data()?;
            let protected = cantrip_framing::remote_surface::decode_protected_payload(&bytes)?;
            Ok(
                json!({"formatVersion":1,"keyRevision":protected.key_revision,"nonce":encode(protected.nonce),"ciphertext":encode(protected.ciphertext)}),
            )
        }
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
        "lock" => {
            service()?.lock();
            Ok(Value::Null)
        }
        "worker-endpoint-protect-bytes" => {
            streams::protect_endpoint_bytes(service()?, context, &data()?)
        }
        "worker-endpoint-open-bytes" => Ok(json!(encode(&streams::open_endpoint_bytes(
            service()?,
            context,
            &input["encrypted"]
        )?))),
        "worker-endpoint-protect" => {
            streams::protect_endpoint_content(service()?, context, &input["content"], schema())
        }
        "worker-endpoint-open" => {
            streams::open_endpoint_content(service()?, context, &input["encrypted"], schema())
        }
        "worker-surface-protect" => {
            streams::protect_surface_content(service()?, context, &input["content"], schema())
        }
        "worker-surface-open" => {
            streams::open_surface_content(service()?, context, &input["encrypted"], schema())
        }
        "worker-remote-protect" => Ok(json!(encode(&streams::protect_remote_surface(
            service()?,
            context,
            &data()?
        )?))),
        "worker-remote-open" => Ok(json!(encode(&streams::open_remote_surface(
            service()?,
            context,
            &data()?
        )?))),
        "replay-reset" => {
            *replay = Default::default();
            Ok(Value::Null)
        }
        "replay-reserve" => {
            replay.reserve(context)?;
            Ok(Value::Null)
        }
        "replay-accept" => {
            replay.accept(context, input["complete"].as_bool().unwrap())?;
            Ok(Value::Null)
        }
        "replay-release" => {
            replay.release(context);
            Ok(Value::Null)
        }
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
    let mut replay = streams::SurfaceStreamReplayGuard::default();
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
            operate(&input, service.as_ref(), &mut replay)
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
