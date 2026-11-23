//! Existing VT stripping and bounded UTF-8 tail semantics; transcript text has
//! its own distinct UTF-16 limit. No terminal emulation or process ownership.
use super::*;
use std::sync::LazyLock;
pub const LIMIT: usize = 256 * 1024;
// Node util.stripVTControlCharacters' OSC/CSI grammar.
static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]").unwrap()
});
pub fn append(current: &Value, delta: &JsString) -> Value {
    if delta.is_empty() {
        return current.clone();
    }
    let plain = replace(delta, &ANSI, |_, _| Vec::new());
    let safe = JsString::new(
        plain
            .units()
            .iter()
            .copied()
            .filter(|&u| !((u < 0x20 && !matches!(u, 9 | 10 | 13)) || (0x7f..=0x9f).contains(&u)))
            .collect(),
    );
    if safe.is_empty() {
        return current.clone();
    }
    let previous = current["output"]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| "".into());
    let previous_bytes = previous.lossy();
    let delta_bytes = safe.lossy();
    if previous_bytes.len() + delta_bytes.len() <= LIMIT {
        return obj([
            ("output", s(concat(&[previous, safe]))),
            ("truncated", current["truncated"].clone()),
        ]);
    }
    let mut bytes = previous_bytes.as_bytes().to_vec();
    bytes.extend_from_slice(delta_bytes.as_bytes());
    let mut start = bytes.len() - LIMIT;
    while start < bytes.len() && (bytes[start] & 0xc0) == 0x80 {
        start += 1;
    }
    obj([
        (
            "output",
            s(String::from_utf8_lossy(&bytes[start..]).as_ref()),
        ),
        ("truncated", Value::Bool(true)),
    ])
}
pub fn bounded(output: Option<&Value>) -> Result<Value> {
    let initial = obj([("output", Value::Null), ("truncated", Value::Bool(false))]);
    let Some(output) = output.filter(|v| !v.is_null()) else {
        return Ok(initial);
    };
    Ok(append(&initial, text(output)?))
}
pub fn transcript(output: Option<&Value>) -> Result<Value> {
    let Some(output) = output else {
        return Ok(Value::Null);
    };
    if output.is_null() {
        return Ok(Value::Null);
    }
    let raw = text(output)?;
    Ok(if raw.len() <= 20_000 {
        output.clone()
    } else {
        s(concat(&[
            "…output truncated…\n".into(),
            slice(raw, raw.len() - 20_000, raw.len()),
        ]))
    })
}
