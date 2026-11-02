use crate::wire::{Value, parse_json_text};

pub(super) fn decode(value: &Value) -> Option<Value> {
    // Buffer.from(text, "base64url") accepts both alphabets, ignores invalid
    // low bytes of UTF-16 units and stops at the first padding character.
    let mut bytes = Vec::new();
    let (mut pending, mut bits) = (0_u32, 0_u32);
    for unit in value.as_js_string()?.units() {
        let byte = *unit as u8;
        let digit = match byte {
            b'=' => break,
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        pending = (pending << 6) | u32::from(digit);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((pending >> bits) as u8);
            pending &= (1 << bits) - 1;
        }
    }
    let decoded = parse_json_text(&String::from_utf8_lossy(&bytes)).ok()?;
    crate::wire::parse("conversationCursorSchema", Some(&decoded)).ok()
}
