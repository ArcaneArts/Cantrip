use cantrip_crypto::*;
use cantrip_wire::{JsString, Value, value::json};
fn aad() -> Value {
    json!({"ownerId":"owner-1","component":"chat-content","table":"messages","rowId":"row-1","field":"content","formatVersion":1,"keyRevision":1})
}
#[test]
fn payload_authentication_context_and_exact_serialization() {
    let key = [7; 32];
    let context = aad();
    let envelope = encrypt_payload(&key, b"hello\0world", &context).unwrap();
    assert_eq!(
        &**decrypt_payload(&key, &envelope, &context).unwrap(),
        b"hello\0world"
    );
    let serialized = serialize_payload(&envelope).unwrap();
    assert!(serialized.starts_with("{\"algorithm\":\"AES-256-GCM\",\"ciphertext\":"));
    assert_eq!(parse_payload(&serialized).unwrap(), envelope);
    let mut wrong_context = context.clone();
    wrong_context["rowId"] = json!("other");
    for result in [
        decrypt_payload(&[8; 32], &envelope, &context),
        decrypt_payload(&key, &envelope, &wrong_context),
    ] {
        assert_eq!(result.unwrap_err().to_string(), DECRYPTION_ERROR);
    }
    let mut wrong_revision = context.clone();
    wrong_revision["keyRevision"] = json!(2);
    assert_eq!(
        decrypt_payload(&key, &envelope, &wrong_revision)
            .unwrap_err()
            .to_string(),
        DECRYPTION_ERROR
    );
    let mut bad = envelope.clone();
    bad["nonce"] = json!("AA");
    assert_eq!(
        decrypt_payload(&key, &bad, &context)
            .unwrap_err()
            .to_string(),
        DECRYPTION_ERROR
    );
    assert_ne!(
        encrypt_payload(&key, b"same", &context).unwrap()["nonce"],
        encrypt_payload(&key, b"same", &context).unwrap()["nonce"]
    );
}
#[test]
fn hpke_grants_authenticate_recipient_and_context() {
    let pair = HpkeKeyPair::generate();
    let wrong = HpkeKeyPair::generate();
    let grant = json!({"workerId":"worker-a","component":"chat-content","keyRevision":3});
    let wrapped =
        wrap_component_key(&[9; 32], &pair.public_key(), &json!("owner"), &grant).unwrap();
    assert_eq!(
        &**unwrap_component_key(&json!("owner"), &wrapped, &pair).unwrap(),
        &[9; 32]
    );
    assert_eq!(
        unwrap_component_key(&json!("other"), &wrapped, &pair)
            .unwrap_err()
            .to_string(),
        DECRYPTION_ERROR
    );
    assert_eq!(
        unwrap_component_key(&json!("owner"), &wrapped, &wrong)
            .unwrap_err()
            .to_string(),
        DECRYPTION_ERROR
    );
    let restored = HpkeKeyPair::import(&pair.private_key(), &pair.public_key()).unwrap();
    assert_eq!(restored.public_key(), pair.public_key());
    assert!(HpkeKeyPair::import(&pair.private_key(), &wrong.public_key()).is_err());
    let mut tampered = wrapped.clone();
    let mut ciphertext = decode(tampered["envelope"]["ciphertext"].as_str().unwrap()).unwrap();
    ciphertext[0] ^= 1;
    tampered["envelope"]["ciphertext"] = json!(encode(&ciphertext));
    assert_eq!(
        unwrap_component_key(&json!("owner"), &tampered, &pair)
            .unwrap_err()
            .to_string(),
        DECRYPTION_ERROR
    );
}
#[test]
fn canonical_bytes_and_key_domain_separation() {
    let context = aad();
    assert_eq!(
        String::from_utf8(associated_data(&context).unwrap()).unwrap(),
        "{\"component\":\"chat-content\",\"field\":\"content\",\"formatVersion\":1,\"keyRevision\":1,\"ownerId\":\"owner-1\",\"rowId\":\"row-1\",\"table\":\"messages\"}"
    );
    let component = derive_component_key(&[7; 32], &context).unwrap();
    let field = derive_field_key(&component, &context).unwrap();
    let lookup = derive_lookup_key(&component, &context).unwrap();
    assert_ne!(*component, *field);
    assert_ne!(*field, *lookup);
    assert_eq!(
        blind_lookup_tag(&lookup, &JsString::from("value"))
            .unwrap()
            .len(),
        43
    );
    for invalid in ["AA=", "AB", "A", "a+", "a/", "AA\n"] {
        assert!(decode(invalid).is_err(), "{invalid:?}");
    }
    assert_eq!(decode("").unwrap(), Vec::<u8>::new());
    let mut bad = context;
    bad["component"] = json!("unknown");
    assert!(associated_data(&bad).is_err());
}

#[test]
fn opens_retained_typescript_ciphertext_vectors() {
    let vector =
        cantrip_wire::parse_json_text(include_str!("fixtures/typescript-v1.json")).unwrap();
    let bytes = |name: &str| decode(vector[name].as_str().unwrap()).unwrap();
    assert_eq!(
        *decrypt_payload(&bytes("key"), &vector["payload"], &vector["aad"]).unwrap(),
        bytes("plaintext")
    );
    let pair = HpkeKeyPair::import(&bytes("privateKey"), &vector["publicKey"]).unwrap();
    assert_eq!(
        *unwrap_key(&vector["wrappedKey"], &pair, &vector["aad"]).unwrap(),
        bytes("key")
    );
}
