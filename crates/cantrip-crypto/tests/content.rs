use cantrip_crypto::{content::*, *};
use cantrip_wire::{Value, value::json};
fn context() -> Value {
    json!({"ownerId":"owner-content","component":"provider-credential","table":"model_providers","rowId":"provider-1","field":"protected_api_key","keyRevision":1})
}
#[test]
fn repository_operations_authenticate_every_route_and_direction() {
    let key = [7; 32];
    let context = json!({"ownerId":"owner", "keyRevision":1, "context":json!({"serverId":"server", "projectId":"project", "worktreeId":"worker", "operationId":"11111111-1111-4111-8111-111111111111", "direction":"request"})});
    let opaque = encrypt_repository_operation(&key, &context, b"private").unwrap();
    assert_eq!(
        decrypt_repository_operation(&key, &context, &opaque)
            .unwrap()
            .as_slice(),
        b"private"
    );
    for (field, value) in [
        ("serverId", "other"),
        ("projectId", "other"),
        ("worktreeId", "other"),
        ("operationId", "22222222-2222-4222-8222-222222222222"),
        ("direction", "response"),
    ] {
        let mut changed = context.clone();
        changed["context"][field] = json!(value);
        assert!(
            decrypt_repository_operation(&key, &changed, &opaque)
                .unwrap_err()
                .is::<DecryptionError>()
        );
    }
    let mut changed = context.clone();
    changed["ownerId"] = json!("other-owner");
    assert!(
        decrypt_repository_operation(&key, &changed, &opaque)
            .unwrap_err()
            .is::<DecryptionError>()
    );
    let mut changed = opaque.clone();
    changed["envelope"]["keyRevision"] = json!(2);
    assert!(
        decrypt_repository_operation(&key, &context, &changed)
            .unwrap_err()
            .is::<DecryptionError>()
    );
    assert!(
        encrypt_repository_operation(
            &key,
            &context,
            &vec![0; REPOSITORY_OPERATION_BYTES_LIMIT + 1]
        )
        .unwrap_err()
        .to_string()
        .contains("too large")
    );
}
#[test]
fn secret_decoder_validates_authenticated_plaintext_and_accepts_utf8_bom() {
    let key = [7; 32];
    let context = context();
    let aad = secret_associated_data(&context).unwrap();
    let derived = derive_field_key(&key, &aad).unwrap();
    let envelope = |bytes: &[u8]| json!({"formatVersion":1,"keyRevision":1,"envelope":encrypt_payload(&derived,bytes,&aad).unwrap()});
    let bom = envelope(b"\xef\xbb\xbf{\"version\":1,\"apiKey\":\" token \"}");
    assert_eq!(
        decrypt_secret(
            &key,
            &context,
            &bom,
            "providerApiKeyProtectedContentSchema",
            None
        )
        .unwrap()["apiKey"],
        "token"
    );
    for bytes in [
        b"\xc3\x28".as_slice(),
        b"{",
        b"{\"version\":2,\"apiKey\":\"token\"}",
    ] {
        let error = decrypt_secret(
            &key,
            &context,
            &envelope(bytes),
            "providerApiKeyProtectedContentSchema",
            None,
        )
        .unwrap_err();
        assert!(error.is::<DecryptionError>());
        assert_eq!(error.to_string(), DECRYPTION_ERROR);
    }
    let error = decrypt_secret(
        &key,
        &context,
        &bom,
        "providerApiKeyProtectedContentSchema",
        Some(1),
    )
    .unwrap_err();
    assert!(error.is::<DecryptionError>());
    assert!(
        encrypt_secret(
            &key,
            &context,
            &json!({"version":1,"apiKey":"token"}),
            "providerApiKeyProtectedContentSchema",
            Some(1)
        )
        .unwrap_err()
        .to_string()
        .contains("byte limit")
    );
}
#[test]
fn private_label_classification_is_authenticated_inside_and_outside() {
    let key = [7; 32];
    let context =
        json!({"ownerId":"owner","recordKind":"project","rowId":"project-1","keyRevision":1});
    let opaque = encrypt_private_label(&key, &context, &json!("label")).unwrap();
    assert_eq!(
        decrypt_private_label(&key, &context, &opaque).unwrap(),
        "label"
    );
    let aad = private_label_associated_data(&context).unwrap();
    let derived = derive_field_key(&key, &aad).unwrap();
    let content = json!({"version":1,"classification":json!({"recordKind":"chat"}),"label":"wrong classification"});
    let mut forged = opaque.clone();
    forged["protectedLabel"]["envelope"] =
        encrypt_payload(&derived, content.stringify().as_bytes(), &aad).unwrap();
    assert!(
        decrypt_private_label(&key, &context, &forged)
            .unwrap_err()
            .is::<DecryptionError>()
    );
    assert!(
        encrypt_private_label(&key, &context, &json!("\0".repeat(1000)))
            .unwrap_err()
            .to_string()
            .contains("encoded byte limit")
    );
}
#[test]
fn attachment_chunk_size_sequence_and_eof_are_bound() {
    let key = [7; 32];
    let context = json!({"ownerId":"owner","chatId":"chat","attachmentId":"attachment","operationId":"operation","direction":"upload","sequence":0,"eof":true,"keyRevision":1});
    let opaque = encrypt_attachment_chunk(&key, &context, b"abc").unwrap();
    assert_eq!(
        &**decrypt_attachment_chunk(&key, &context, &opaque).unwrap(),
        b"abc"
    );
    let mut tampered = opaque.clone();
    tampered["eof"] = json!(false);
    assert!(
        decrypt_attachment_chunk(&key, &context, &tampered)
            .unwrap_err()
            .is::<DecryptionError>()
    );
    let aad = attachment_chunk_associated_data(&context, &json!(3), &json!(true)).unwrap();
    let derived = derive_field_key(&key, &aad).unwrap();
    let mut short = opaque;
    short["envelope"] = encrypt_payload(&derived, b"ab", &aad).unwrap();
    assert!(
        decrypt_attachment_chunk(&key, &context, &short)
            .unwrap_err()
            .is::<DecryptionError>()
    );
    assert!(
        encrypt_attachment_chunk(&key, &context, &vec![0; ATTACHMENT_CHUNK_LIMIT + 1]).is_err()
    );
}
#[test]
fn endpoint_payload_is_bound_to_server_operation_direction_and_sequence() {
    let key = [7; 32];
    let context = json!({"ownerId":"owner","keyRevision":1,"context":json!({"domain":"run-content","serverId":"server-a","workerId":Value::Null,"scopeId":"scope","operationId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","operation":"run","direction":"request","sequence":0})});
    let opaque = encrypt_endpoint(&key, &context, &[0, 255, 128]).unwrap();
    assert_eq!(
        *decrypt_endpoint(&key, &context, &opaque).unwrap(),
        vec![0, 255, 128]
    );
    for (field, value) in [
        ("serverId", json!("server-b")),
        ("direction", json!("response")),
        ("sequence", json!(1)),
    ] {
        let mut different = context.clone();
        different["context"][field] = value;
        assert!(
            decrypt_endpoint(&key, &different, &opaque)
                .unwrap_err()
                .is::<DecryptionError>()
        );
    }
}
