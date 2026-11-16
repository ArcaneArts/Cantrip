use crate::{
    associated_data, checked, decryption_error, encode, encoded_field, random_bytes, require_length,
};
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Result, anyhow};
use cantrip_wire::{Value, value::json};
use zeroize::Zeroizing;

pub fn encrypt_payload(key: &[u8], plaintext: &[u8], aad: &Value) -> Result<Value> {
    require_length(key, 32, "Key")?;
    let nonce = random_bytes(12)?;
    let aad_bytes = associated_data(aad)?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| anyhow!("Invalid encryption key."))?;
    let ciphertext = cipher
        .encrypt(
            &Nonce::try_from(nonce.as_slice()).map_err(|_| anyhow!("Invalid payload nonce."))?,
            Payload {
                msg: plaintext,
                aad: &aad_bytes,
            },
        )
        .map_err(|_| anyhow!("Payload encryption failed."))?;
    checked(
        "encryptedPayloadEnvelopeSchema",
        &json!({"version":1,"algorithm":"AES-256-GCM","keyRevision":aad["keyRevision"],"nonce":encode(&nonce),"ciphertext":encode(&ciphertext)}),
    )
}
pub fn decrypt_payload(key: &[u8], envelope: &Value, aad: &Value) -> Result<Zeroizing<Vec<u8>>> {
    let open = || -> Result<Zeroizing<Vec<u8>>> {
        require_length(key, 32, "Key")?;
        let v = checked("encryptedPayloadEnvelopeSchema", envelope)?;
        if v["keyRevision"] != aad["keyRevision"] {
            return Err(decryption_error());
        }
        let nonce = encoded_field(&v, "nonce")?;
        let ciphertext = encoded_field(&v, "ciphertext")?;
        let aad = associated_data(aad)?;
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| decryption_error())?;
        Ok(Zeroizing::new(
            cipher
                .decrypt(
                    &Nonce::try_from(nonce.as_slice())
                        .map_err(|_| anyhow!("Invalid payload nonce."))?,
                    Payload {
                        msg: &ciphertext,
                        aad: &aad,
                    },
                )
                .map_err(|_| decryption_error())?,
        ))
    };
    open().map_err(|_| decryption_error())
}
pub fn serialize_payload(input: &Value) -> Result<String> {
    let v = checked("encryptedPayloadEnvelopeSchema", input)?;
    Ok(json!({"algorithm":v["algorithm"],"ciphertext":v["ciphertext"],"keyRevision":v["keyRevision"],"nonce":v["nonce"],"version":v["version"]}).stringify())
}
pub fn parse_payload(input: &str) -> Result<Value> {
    checked(
        "encryptedPayloadEnvelopeSchema",
        &cantrip_wire::parse_json_text(input).map_err(|error| anyhow!("{}", error.lossy()))?,
    )
}
