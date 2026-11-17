use cantrip_framing::remote_surface::*;

#[test]
fn protected_payload_preserves_big_endian_revision_and_borrowed_parts() {
    let nonce = [9; 12];
    let ciphertext = [7; 20];
    let bytes = encode_protected_payload(ProtectedPayload {
        key_revision: 0x01020304,
        nonce: &nonce,
        ciphertext: &ciphertext,
    })
    .unwrap();
    assert_eq!(&bytes[..9], &[1, 0, 0, 0, 0, 1, 2, 3, 4]);
    let decoded = decode_protected_payload(&bytes).unwrap();
    assert_eq!(decoded.key_revision, 0x01020304);
    assert_eq!(decoded.nonce, nonce);
    assert_eq!(decoded.ciphertext, ciphertext);
    for end in 0..PROTECTED_HEADER_BYTES + PROTECTED_TAG_BYTES {
        assert!(decode_protected_payload(&bytes[..end]).is_err());
    }
    let mut invalid = bytes;
    invalid[0] = 2;
    assert!(
        decode_protected_payload(&invalid)
            .err()
            .unwrap()
            .to_string()
            .contains("unsupported")
    );
}

#[test]
fn protected_payload_checks_revision_and_exact_transport_limit() {
    let nonce = [0; 12];
    let ciphertext = vec![0; MAX_PROTECTED_PLAINTEXT_BYTES + PROTECTED_TAG_BYTES];
    let mut bytes = encode_protected_payload(ProtectedPayload {
        key_revision: 2_147_483_647,
        nonce: &nonce,
        ciphertext: &ciphertext,
    })
    .unwrap();
    assert_eq!(bytes.len(), MAX_PAYLOAD_BYTES);
    assert!(decode_protected_payload(&bytes).is_ok());
    bytes.push(0);
    assert!(decode_protected_payload(&bytes).is_err());
    bytes.pop();
    bytes[1..9].copy_from_slice(&9_007_199_254_740_992_u64.to_be_bytes());
    assert!(decode_protected_payload(&bytes).is_err());
    assert!(
        encode_protected_payload(ProtectedPayload {
            key_revision: 0,
            nonce: &nonce,
            ciphertext: &[0; 16]
        })
        .is_err()
    );
}
