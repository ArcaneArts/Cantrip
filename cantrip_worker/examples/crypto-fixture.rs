//! Development oracle that emits synthetic private material. Never use real
//! profiles/keys. Production worker startup never invokes this executable.
use anyhow::{Result, anyhow};
use cantrip_crypto::*;
use cantrip_wire::{Value, parse_json_text, value::json};
use std::io::{self, BufRead};
fn operate(input: &Value) -> Result<Value> {
    let bytes = |name: &str| -> Result<Vec<u8>> {
        decode(
            input[name]
                .as_str()
                .ok_or_else(|| anyhow!("Missing fixture bytes"))?,
        )
    };
    let key = || bytes("key");
    let pair = || -> Result<HpkeKeyPair> {
        HpkeKeyPair::import(&bytes("privateKey")?, &input["publicKey"])
    };
    match input["op"].as_str().unwrap_or("") {
        "aad" => Ok(json!(String::from_utf8(associated_data(&input["aad"])?)?)),
        "derive" => {
            let component = derive_component_key(&key()?, &input["context"])?;
            let field = derive_field_key(&component, &input["context"])?;
            let lookup = derive_lookup_key(&component, &input["context"])?;
            Ok(
                json!({"component":encode(&component),"field":encode(&field),"lookup":encode(&lookup),"tag":blind_lookup_tag(&lookup,input["canonical"].as_js_string().ok_or_else(||anyhow!("Missing lookup text"))?)?}),
            )
        }
        "encrypt" => encrypt_payload(&key()?, &bytes("plaintext")?, &input["aad"]),
        "decrypt" => Ok(json!(encode(&decrypt_payload(
            &key()?,
            &input["envelope"],
            &input["aad"]
        )?))),
        "serialize" => Ok(json!(serialize_payload(&input["envelope"])?)),
        "generate" => {
            let keys = HpkeKeyPair::generate();
            Ok(json!({"publicKey":keys.public_key(),"privateKey":encode(&keys.private_key())}))
        }
        "wrap" => wrap_key(&key()?, &input["publicKey"], &input["aad"]),
        "unwrap" => Ok(json!(encode(&unwrap_key(
            &input["envelope"],
            &pair()?,
            &input["aad"]
        )?))),
        "wrap-component" => wrap_component_key(
            &key()?,
            &input["publicKey"],
            &input["ownerId"],
            &input["grant"],
        ),
        "unwrap-component" => Ok(json!(encode(&unwrap_component_key(
            &input["ownerId"],
            &input["grant"],
            &pair()?
        )?))),
        "identity" | "identity-persist" => {
            let mut identity = cantrip_worker::encryption::Identity::open(
                std::path::Path::new(input["directory"].as_str().unwrap()),
                input["serverUrl"].as_str().unwrap(),
                input["workerId"].as_js_string().unwrap(),
                input["allowPortChange"].as_bool().unwrap_or(false),
            )?;
            if input["op"] == "identity-persist" {
                identity.persist_binding(
                    &input["ownerId"],
                    &input["serverId"],
                    &input["revisions"],
                )?;
            }
            Ok(identity.registration())
        }
        _ => Err(anyhow!("Unknown fixture operation")),
    }
}
fn main() {
    for line in io::stdin().lock().lines() {
        let result = line
            .map_err(anyhow::Error::from)
            .and_then(|line| parse_json_text(&line).map_err(|e| anyhow!("{}", e.lossy())))
            .and_then(|input| operate(&input));
        let output = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => {
                json!({"ok":false,"error":error.to_string(),"code":error.downcast_ref::<cantrip_worker::encryption::IdentityError>().map(|e|e.code)})
            }
        };
        println!("{}", output.stringify());
    }
}
