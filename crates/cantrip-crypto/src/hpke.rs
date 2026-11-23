use crate::{associated_data, checked, decryption_error, encode, encoded_field, require_length};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{Value, value::json};
use hpke::{
    Deserializable, Kem as _, OpModeR, OpModeS, Serializable, aead::AesGcm256, kdf::HkdfSha256,
    kem::DhP256HkdfSha256,
};
use zeroize::{Zeroize, Zeroizing};

type Kem = DhP256HkdfSha256;
type Private = <Kem as hpke::Kem>::PrivateKey;
type Public = <Kem as hpke::Kem>::PublicKey;
const INFO: &[u8] = b"cantrip:e2ee:hpke-key-wrap:v1";

/// The private key implementation zeroizes on drop. Deliberately no Debug/serde.
pub struct HpkeKeyPair {
    private: Private,
    public: Public,
}
impl HpkeKeyPair {
    pub fn generate() -> Self {
        let (private, public) = Kem::gen_keypair();
        Self { private, public }
    }
    pub fn import(private: &[u8], public: &Value) -> Result<Self> {
        require_length(private, 32, "HPKE private key")?;
        let private =
            Private::from_bytes(private).map_err(|_| anyhow!("Invalid HPKE private key."))?;
        let public = import_public(public)?;
        if Kem::sk_to_pk(&private) != public {
            bail!("The stored worker encryption keypair does not match.");
        }
        Ok(Self { private, public })
    }
    pub fn public_key(&self) -> Value {
        json!({"version":1,"algorithm":"P-256","format":"raw","value":encode(&self.public.to_bytes())})
    }
    pub fn private_key(&self) -> Zeroizing<Vec<u8>> {
        let mut bytes = self.private.to_bytes();
        let result = Zeroizing::new(bytes.to_vec());
        bytes.as_mut_slice().zeroize();
        result
    }
}
fn import_public(input: &Value) -> Result<Public> {
    let value = checked("encryptionPublicKeySchema", input)?;
    Public::from_bytes(&encoded_field(&value, "value")?)
        .map_err(|_| anyhow!("Invalid HPKE public key."))
}
pub fn wrap_key(key: &[u8], recipient: &Value, aad: &Value) -> Result<Value> {
    require_length(key, 32, "Key")?;
    let public = import_public(recipient)?;
    let (enc, ciphertext) = hpke::single_shot_seal::<AesGcm256, HkdfSha256, Kem>(
        &OpModeS::Base,
        &public,
        INFO,
        key,
        &associated_data(aad)?,
    )
    .map_err(|_| anyhow!("HPKE key wrapping failed."))?;
    checked(
        "hpkeWrappedKeyEnvelopeSchema",
        &json!({"version":1,"algorithm":"HPKE-RFC9180","suite":json!({"mode":"base","kem":"DHKEM(P-256,HKDF-SHA256)","kdf":"HKDF-SHA256","aead":"AES-256-GCM"}),"encapsulatedKey":encode(&enc.to_bytes()),"ciphertext":encode(&ciphertext)}),
    )
}
pub fn unwrap_key(
    envelope: &Value,
    recipient: &HpkeKeyPair,
    aad: &Value,
) -> Result<Zeroizing<Vec<u8>>> {
    let open = || -> Result<Zeroizing<Vec<u8>>> {
        let envelope = checked("hpkeWrappedKeyEnvelopeSchema", envelope)?;
        let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(&encoded_field(
            &envelope,
            "encapsulatedKey",
        )?)
        .map_err(|_| decryption_error())?;
        let bytes = Zeroizing::new(
            hpke::single_shot_open::<AesGcm256, HkdfSha256, Kem>(
                &OpModeR::Base,
                &recipient.private,
                &enc,
                INFO,
                &encoded_field(&envelope, "ciphertext")?,
                &associated_data(aad)?,
            )
            .map_err(|_| decryption_error())?,
        );
        require_length(&bytes, 32, "Key")?;
        Ok(bytes)
    };
    open().map_err(|_| decryption_error())
}
pub fn worker_grant_aad(owner: &Value, grant: &Value) -> Value {
    json!({"ownerId":owner,"component":grant["component"],"table":"encryption_worker_grants","rowId":grant["workerId"],"field":"wrapped_component_key","formatVersion":1,"keyRevision":grant["keyRevision"]})
}
pub fn wrap_component_key(
    key: &[u8],
    recipient: &Value,
    owner: &Value,
    grant: &Value,
) -> Result<Value> {
    let envelope = wrap_key(key, recipient, &worker_grant_aad(owner, grant))?;
    checked(
        "workerComponentKeyGrantSchema",
        &json!({"version":1,"purpose":"worker-component-key","workerId":grant["workerId"],"component":grant["component"],"keyRevision":grant["keyRevision"],"envelope":envelope}),
    )
}
pub fn unwrap_component_key(
    owner: &Value,
    grant: &Value,
    recipient: &HpkeKeyPair,
) -> Result<Zeroizing<Vec<u8>>> {
    let grant = checked("workerComponentKeyGrantSchema", grant)?;
    unwrap_key(
        &grant["envelope"],
        recipient,
        &worker_grant_aad(owner, &grant),
    )
}
