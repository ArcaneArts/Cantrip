//! Existing tunnel data AEAD. Frame validation, routing, sequence admission and
//! transfer authorization stay with their owning adapters.
use crate::{checked, decode, encode, random_bytes};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{Value, value::json};
use zeroize::Zeroizing;

pub struct SealedTunnelData {
    pub header: Value,
    pub payload: Vec<u8>,
}
fn key(configuration: &Value) -> Result<Zeroizing<Vec<u8>>> {
    let configuration = checked("tunnelDataProtectionConfigurationSchema", configuration)?;
    let bytes = Zeroizing::new(decode(configuration["key"].as_str().unwrap())?);
    if bytes.len() != 32 {
        bail!("Tunnel data protection key is invalid.");
    }
    Ok(bytes)
}
fn aad(header: &Value, protection: &Value) -> Vec<u8> {
    Value::Array(vec![
        header["protocolVersion"].clone(),
        header["tunnelId"].clone(),
        header["attachmentId"].clone(),
        header["sourceEndpointId"].clone(),
        header["destinationEndpointId"].clone(),
        header["connectionId"].clone(),
        header["sequence"].clone(),
        header["kind"].clone(),
        header["direction"].clone(),
        protection["formatVersion"].clone(),
        protection["algorithm"].clone(),
        protection["keyRevision"].clone(),
        protection["nonce"].clone(),
    ])
    .stringify()
    .into_bytes()
}
/// The owning adapter supplies a protocol-validated data header.
pub fn seal_tunnel_data_frame(
    configuration: &Value,
    header: &Value,
    plaintext: &[u8],
) -> Result<SealedTunnelData> {
    let nonce = random_bytes(12)?;
    let protection = json!({"formatVersion":1,"algorithm":"AES-256-GCM","keyRevision":configuration["keyRevision"],"nonce":encode(&nonce)});
    let key = key(configuration)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| anyhow!("Tunnel data protection key is invalid."))?;
    let payload = cipher
        .encrypt(
            &Nonce::try_from(nonce.as_slice()).unwrap(),
            Payload {
                msg: plaintext,
                aad: &aad(header, &protection),
            },
        )
        .map_err(|_| anyhow!("Tunnel data encryption failed."))?;
    let mut header = header.clone();
    let Value::Object(fields) = &mut header else {
        bail!("Expected a tunnel data header.");
    };
    fields.insert("protection".into(), protection);
    Ok(SealedTunnelData { header, payload })
}
/// The owning adapter supplies a protocol-validated data header (including a
/// canonical twelve-byte nonce). No route or sequence authority is inferred.
pub fn open_tunnel_data_frame(
    configuration: &Value,
    header: &Value,
    payload: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    let protection = &header["protection"];
    if protection.is_null()
        || protection["keyRevision"] != configuration["keyRevision"]
        || payload.len() <= 16
    {
        bail!("Tunnel data protection metadata is invalid.");
    }
    let nonce = decode(
        protection["nonce"]
            .as_str()
            .ok_or_else(|| anyhow!("Invalid initialization vector"))?,
    )?;
    let key = key(configuration)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| anyhow!("Tunnel data protection key is invalid."))?;
    let nonce =
        Nonce::try_from(nonce.as_slice()).map_err(|_| anyhow!("Invalid initialization vector"))?;
    Ok(Zeroizing::new(
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: payload,
                    aad: &aad(header, protection),
                },
            )
            // Existing Node 24 crypto failure text. The destination adapter
            // classifies this failure as data-open-failed and retires the route.
            .map_err(|_| anyhow!("error:1C800064:Provider routines::bad decrypt"))?,
    ))
}
