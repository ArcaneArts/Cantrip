use cantrip_crypto::{content::*, *};
use cantrip_wire::{Value, value::json};

fn surface() -> Value {
    json!({"ownerId":"owner","keyRevision":3,"context":json!({"serverId":"server","surfaceKind":"terminal","surfaceId":"terminal","operationId":"operation","direction":"input","sequence":0})})
}
fn remote() -> Value {
    json!({"ownerId":"owner","keyRevision":3,"context":json!({"serverId":"server","surfaceKind":"browser","surfaceId":"browser","attachmentId":"attachment","direction":"worker-to-client","channel":"frame","sequence":0})})
}

#[test]
fn surface_stream_authenticates_domain_direction_sequence_and_key_revision() {
    let key = [7; 32];
    let context = surface();
    let encrypted = encrypt_surface_stream(&key, &context, b"input").unwrap();
    assert_eq!(
        &**decrypt_surface_stream(&key, &context, &encrypted).unwrap(),
        b"input"
    );
    for (field, value) in [
        ("serverId", json!("other")),
        ("direction", json!("output")),
        ("sequence", json!(1)),
        ("surfaceKind", json!("explorer")),
    ] {
        let mut wrong = context.clone();
        wrong["context"][field] = value;
        assert!(
            decrypt_surface_stream(&key, &wrong, &encrypted)
                .unwrap_err()
                .is::<DecryptionError>()
        );
    }
    let mut wrong = encrypted;
    wrong["keyRevision"] = json!(4);
    assert!(
        decrypt_surface_stream(&key, &context, &wrong)
            .unwrap_err()
            .is::<DecryptionError>()
    );
    assert!(
        encrypt_surface_stream(&key, &context, &vec![0; SURFACE_STREAM_BYTES_LIMIT + 1]).is_err()
    );
}
#[test]
fn remote_binary_payload_authenticates_attachment_channel_and_empty_plaintext() {
    let key = [7; 32];
    let context = remote();
    let mut bytes = encrypt_remote_stream(&key, &context, b"").unwrap();
    assert_eq!(bytes.len(), 37);
    assert!(
        decrypt_remote_stream(&key, &context, &bytes)
            .unwrap()
            .is_empty()
    );
    for (field, value) in [
        ("attachmentId", json!("other")),
        ("channel", json!("cursor")),
        ("sequence", json!(1)),
    ] {
        let mut wrong = context.clone();
        wrong["context"][field] = value;
        assert!(
            decrypt_remote_stream(&key, &wrong, &bytes)
                .unwrap_err()
                .is::<DecryptionError>()
        );
    }
    bytes[36] ^= 1;
    assert!(
        decrypt_remote_stream(&key, &context, &bytes)
            .unwrap_err()
            .is::<DecryptionError>()
    );
    assert!(
        decrypt_remote_stream(&key, &context, &bytes[..20])
            .unwrap_err()
            .is::<DecryptionError>()
    );
}
#[test]
fn tunnel_opens_existing_cross_runtime_vector_and_binds_full_route() {
    let configuration =
        json!({"formatVersion":1,"algorithm":"AES-256-GCM","keyRevision":3,"key":encode(&[7;32])});
    let header = json!({"protocolVersion":1,"tunnelId":"tunnel","attachmentId":"attachment","sourceEndpointId":"desktop:one:attachment","destinationEndpointId":"worker:one","connectionId":"connection","sequence":4,"kind":"data","direction":"source-to-destination","protection":json!({"formatVersion":1,"algorithm":"AES-256-GCM","keyRevision":3,"nonce":"CQkJCQkJCQkJCQkJ"})});
    let bytes = decode("RPfr583dsxTOFqJVg8rBpqDVEKBB_3Ez7M0m4OcZVNhpfMk").unwrap();
    assert_eq!(
        &**open_tunnel_data_frame(&configuration, &header, &bytes).unwrap(),
        b"cross-runtime bytes"
    );
    let encrypted = seal_tunnel_data_frame(&configuration, &header, b"data").unwrap();
    assert_eq!(
        &**open_tunnel_data_frame(&configuration, &encrypted.header, &encrypted.payload).unwrap(),
        b"data"
    );
    let mut wrong = encrypted.header;
    wrong["connectionId"] = json!("different");
    assert!(open_tunnel_data_frame(&configuration, &wrong, &encrypted.payload).is_err());
    // Preserve the existing helper's empty-seal/open asymmetry. The carrier
    // rejects tag-only data frames before routing them.
    let empty = seal_tunnel_data_frame(&configuration, &header, b"").unwrap();
    assert!(
        open_tunnel_data_frame(&configuration, &empty.header, &empty.payload)
            .unwrap_err()
            .to_string()
            .contains("metadata")
    );
}
