use crate::native_items::replace;
use cantrip_wire::JsString;
use icu_normalizer::ComposingNormalizer;
use regress::Regex;
use std::sync::OnceLock;

pub const MAX_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 256 * 1024;

pub fn safe_filename(value: &JsString) -> JsString {
    let units: Vec<_> = value
        .units()
        .iter()
        .map(|u| if *u == 92 { 47 } else { *u })
        .collect();
    let end = units.iter().rposition(|u| *u != 47).map_or(0, |i| i + 1);
    let start = units[..end]
        .iter()
        .rposition(|u| *u == 47)
        .map_or(0, |i| i + 1);
    #[cfg(windows)]
    let start = if start == 0
        && end >= 2
        && units[1] == 58
        && units[0] < 128
        && (units[0] as u8).is_ascii_alphabetic()
    {
        2
    } else {
        start
    };
    let normalized = ComposingNormalizer::new_nfkc().normalize_utf16(&units[start..end]);
    let clean = JsString::new(
        normalized
            .iter()
            .copied()
            .filter(|u| *u > 31 && *u != 127)
            .collect(),
    );
    static INVALID: OnceLock<Regex> = OnceLock::new();
    let clean = replace(
        &clean,
        INVALID.get_or_init(|| Regex::with_flags(r"[^\p{L}\p{N}._()\[\] -]", "u").unwrap()),
        |_, _| vec![95],
    );
    let mut output = Vec::new();
    for unit in clean.units() {
        if *unit != 32 || output.last() != Some(&32) {
            output.push(*unit);
        }
    }
    let start = output.iter().position(|u| *u != 32).unwrap_or(output.len());
    let end = output
        .iter()
        .rposition(|u| *u != 32)
        .map_or(start, |i| i + 1);
    let value = &output[start..end];
    let start = value.iter().position(|u| *u != 46).unwrap_or(value.len());
    let value = &value[start..];
    if value.is_empty() {
        "attachment".into()
    } else {
        JsString::new(value[..value.len().min(180)].to_vec())
    }
}

pub(crate) fn segment(value: &JsString, label: &str) -> anyhow::Result<String> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .units()
            .iter()
            .all(|u| matches!(u, 45 | 95 | 48..=57 | 65..=90 | 97..=122))
    {
        anyhow::bail!("{label} is invalid.");
    }
    Ok(value.lossy().into_owned())
}
