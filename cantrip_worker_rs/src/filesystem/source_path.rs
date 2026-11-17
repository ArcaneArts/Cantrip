//! Existing project-source path representations, including file URLs and native
//! Windows namespace/drive normalization. Pure normalization performs no IO.
use super::paths;
use anyhow::{Result, bail};
use cantrip_wire::JsString;
use std::path::PathBuf;

fn scheme(value: &[u16]) -> bool {
    value.first().is_some_and(|c| c.is_ascii_alphabetic())
        && value
            .iter()
            .skip(1)
            .all(|c| c.is_ascii_alphanumeric() || [43, 45, 46].contains(c))
}
trait AsciiUnit {
    fn is_ascii_alphabetic(&self) -> bool;
    fn is_ascii_alphanumeric(&self) -> bool;
}
impl AsciiUnit for u16 {
    fn is_ascii_alphabetic(&self) -> bool {
        *self < 128 && (*self as u8).is_ascii_alphabetic()
    }
    fn is_ascii_alphanumeric(&self) -> bool {
        *self < 128 && (*self as u8).is_ascii_alphanumeric()
    }
}
fn drive(units: &[u16]) -> bool {
    units.len() >= 2 && units[0].is_ascii_alphabetic() && units[1] == 58
}
fn file_url(input: &JsString, windows: bool) -> Result<JsString> {
    let url = url::Url::parse(&input.lossy())?;
    let path = url.path();
    let bytes = path.as_bytes();
    for (i, &byte) in bytes.iter().enumerate() {
        if byte != b'%' {
            continue;
        }
        let digits = bytes
            .get(i + 1..i + 3)
            .filter(|v| v.iter().all(u8::is_ascii_hexdigit));
        let Some(digits) = digits else {
            bail!("Project source path uses an invalid file URL.");
        };
        let encoded = std::str::from_utf8(digits).unwrap();
        if encoded.eq_ignore_ascii_case("2f") || windows && encoded.eq_ignore_ascii_case("5c") {
            bail!("Project source path uses an invalid file URL.");
        }
    }
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8()?;
    let host = url.host_str().unwrap_or("");
    if windows {
        if !host.is_empty() {
            let (host, status) = idna::domain_to_unicode(host);
            status.map_err(|_| anyhow::anyhow!("Project source path uses an invalid file URL."))?;
            return Ok(format!("\\\\{host}{}", decoded.replace('/', "\\")).into());
        }
        let units: Vec<_> = decoded.encode_utf16().collect();
        if units.first() != Some(&47) || !drive(&units[1..]) {
            bail!("Project source path uses an invalid file URL.");
        }
        Ok(JsString::new(units[1..].to_vec()))
    } else {
        if !host.is_empty() && host != "localhost" {
            bail!("Project source path uses an invalid file URL.");
        }
        Ok(decoded.as_ref().into())
    }
}
pub fn normalize(input: &JsString, windows: bool) -> Result<JsString> {
    let mut value = input.clone();
    let units = value.units();
    if units.get(..5).is_some_and(|v| {
        v.iter()
            .copied()
            .map(|u| {
                if u < 128 {
                    (u as u8).to_ascii_lowercase() as u16
                } else {
                    u
                }
            })
            .eq("file:".encode_utf16())
    }) {
        value = file_url(&value, windows)?;
    } else if let Some(colon) = units.iter().position(|u| *u == 58)
        && scheme(&units[..colon])
        && !(windows && drive(units))
    {
        bail!("Project source path uses an unsupported URL scheme.");
    }
    if windows {
        return windows_path(&value);
    }
    if value.units().first() != Some(&47) {
        bail!("Project source path must be absolute.");
    }
    let trailing = value.units().last() == Some(&47);
    let mut segments = Vec::<&[u16]>::new();
    for part in value.units().split(|u| *u == 47) {
        if part.is_empty() || part == [46] {
            continue;
        }
        if part == [46, 46] {
            segments.pop();
        } else {
            segments.push(part);
        }
    }
    let mut result = vec![47];
    for (i, part) in segments.iter().enumerate() {
        if i != 0 {
            result.push(47);
        }
        result.extend_from_slice(part);
    }
    if trailing && !segments.is_empty() {
        result.push(47);
    }
    Ok(JsString::new(result))
}
fn windows_path(value: &JsString) -> Result<JsString> {
    let mut units: Vec<_> = value
        .units()
        .iter()
        .map(|u| if *u == 47 { 92 } else { *u })
        .collect();
    let unc: Vec<_> = "\\\\?\\UNC\\".encode_utf16().collect();
    if units.len() > unc.len()
        && units[..unc.len()].iter().zip(&unc).all(|(a, b)| {
            a == b || *a < 128 && *b < 128 && (*a as u8).eq_ignore_ascii_case(&(*b as u8))
        })
        && !units[unc.len()..]
            .iter()
            .any(|u| [10, 13, 0x2028, 0x2029].contains(u))
    {
        units = [&[92, 92][..], &units[unc.len()..]].concat();
    } else if units.starts_with(&[92, 92, 63, 92])
        && drive(&units[4..])
        && units.get(6) == Some(&92)
        && !units[7..]
            .iter()
            .any(|u| [10, 13, 0x2028, 0x2029].contains(u))
    {
        units.drain(..4);
    }
    let (mut result, tail) = if drive(&units) && units.get(2) == Some(&92) {
        (
            vec![(units[0] as u8).to_ascii_uppercase() as u16, 58, 92],
            &units[3..],
        )
    } else if units.starts_with(&[92, 92]) && units.get(2).is_some_and(|u| *u != 92) {
        let first = units[2..].iter().position(|u| *u == 92).map(|i| i + 2);
        let Some(first) = first else {
            bail!("Project source path must be an absolute Windows path.");
        };
        if units.get(first + 1).is_none_or(|u| *u == 92) {
            bail!("Project source path must be an absolute Windows path.");
        }
        let end = units[first + 1..]
            .iter()
            .position(|u| *u == 92)
            .map_or(units.len(), |i| first + 1 + i);
        let mut root = units[..end].to_vec();
        root.push(92);
        (root, &units[end..])
    } else {
        bail!("Project source path must be an absolute Windows path.");
    };
    let trailing = units.last() == Some(&92);
    let mut parts = Vec::<&[u16]>::new();
    for part in tail.split(|u| *u == 92) {
        if part.is_empty() || part == [46] {
            continue;
        }
        if part == [46, 46] {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    for (i, part) in parts.iter().enumerate() {
        if i != 0 {
            result.push(92);
        }
        result.extend_from_slice(part);
    }
    if trailing && !parts.is_empty() {
        result.push(92);
    }
    Ok(JsString::new(result))
}
pub async fn canonical(input: &JsString) -> Result<PathBuf> {
    let requested = paths::native(&normalize(input, cfg!(windows))?);
    let canonical = paths::canonical(&requested).await?;
    let canonical = paths::native(&normalize(&paths::text(&canonical), cfg!(windows))?);
    if !tokio::fs::symlink_metadata(&canonical).await?.is_dir() {
        bail!("Project source path is not a directory.");
    }
    Ok(canonical)
}
