use std::{
    collections::HashMap,
    net::IpAddr,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

use regex::Regex;
use serde_json::{Value, json};
use url::Url;

use super::{ConfigError, Result};

pub type Environment = HashMap<String, String>;

pub(super) fn whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(super) fn trim(value: &str) -> &str {
    value.trim_matches(whitespace)
}
pub(super) fn length(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(super) struct Reader<'a>(pub &'a Environment);

impl Reader<'_> {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }
    pub fn text(&self, name: &str, default: &str) -> String {
        self.get(name).unwrap_or(default).into()
    }
    // Keep empty strings where the TypeScript source used ?.trim() without ||.
    pub fn trimmed(&self, name: &str) -> Option<String> {
        self.get(name).map(|value| trim(value).into())
    }
    pub fn nonempty(&self, name: &str) -> Option<String> {
        self.trimmed(name).filter(|value| !value.is_empty())
    }
    pub fn boolean(&self, name: &str) -> Result<bool> {
        match self.get(name) {
            None | Some("false" | "0") => Ok(false),
            Some("true" | "1") => Ok(true),
            _ => Err(ConfigError::new(format!(
                "Invalid {name}: expected true, false, 1, or 0."
            ))),
        }
    }
    pub fn enabled(&self, name: &str) -> Result<bool> {
        Ok(self.get(name).is_none() || self.boolean(name)?)
    }
    pub fn bounded(&self, name: &str, fallback: u64, minimum: u64, maximum: u64) -> Result<u64> {
        let Some(raw) = self.get(name) else {
            return Ok(fallback);
        };
        let input = raw.trim_start_matches(whitespace);
        let (negative, input) = if let Some(rest) = input.strip_prefix('-') {
            (true, rest)
        } else {
            (false, input.strip_prefix('+').unwrap_or(input))
        };
        let digits = &input[..input.bytes().take_while(u8::is_ascii_digit).count()];
        if let Ok(value) = digits.parse::<u64>()
            && (!negative || value == 0)
            && value >= minimum
            && value <= maximum
        {
            return Ok(value);
        }
        Err(ConfigError::new(format!("Invalid {name}: {raw}")))
    }
    pub fn list(&self, name: &str, fallback: &[&str], unique: bool) -> Result<Vec<String>> {
        let values: Vec<_> = match self.get(name) {
            Some(value) => value
                .split(',')
                .map(trim)
                .filter(|v| !v.is_empty())
                .map(String::from)
                .collect(),
            None => fallback.iter().map(|v| String::from(*v)).collect(),
        };
        if unique {
            let mut seen = std::collections::HashSet::new();
            if values.iter().any(|v| !seen.insert(v)) {
                return Err(ConfigError::new(format!("{name} entries must be unique.")));
            }
        }
        Ok(values)
    }
}

pub(super) fn enumeration(
    reader: &Reader<'_>,
    name: &str,
    default: &str,
    choices: &[&str],
) -> Result<String> {
    let value = reader.text(name, default);
    if choices.contains(&value.as_str()) {
        return Ok(value);
    }
    let options = choices
        .iter()
        .map(|v| format!("\"{v}\""))
        .collect::<Vec<_>>()
        .join("|");
    Err(ConfigError::zod(vec![
        json!({"code":"invalid_value", "values":choices, "path":[], "message":format!("Invalid option: expected one of {options}")}),
    ]))
}

pub(super) fn email(value: &str) -> bool {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    !value.starts_with('.') && !value.contains("..") && length(value) <= 320 &&
        PATTERN.get_or_init(|| Regex::new(r"\A[A-Za-z0-9_'+\-.]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}\z").unwrap()).is_match(value)
}

pub(super) fn origin(name: &str, value: &str, https: bool) -> Result<String> {
    let parsed = Url::parse(value)
        .map_err(|_| ConfigError::new(format!("{name} must be a valid HTTP(S) origin.")))?;
    if !["http", "https"].contains(&parsed.scheme())
        || parsed.path() != "/"
        || parsed.query().is_some_and(|v| !v.is_empty())
        || parsed.fragment().is_some_and(|v| !v.is_empty())
        || !parsed.username().is_empty()
        || parsed.password().is_some_and(|v| !v.is_empty())
    {
        return Err(ConfigError::new(format!(
            "{name} must be an HTTP(S) origin without a path, wildcard, or credentials."
        )));
    }
    if https && parsed.scheme() != "https" {
        return Err(ConfigError::new(format!(
            "{name} must use HTTPS in hosted mode."
        )));
    }
    Ok(parsed.origin().ascii_serialization())
}

pub(super) fn app_origins(reader: &Reader<'_>, hosted: bool) -> Result<Vec<String>> {
    let configured = reader
        .get("CANTRIP_APP_ORIGINS")
        .or_else(|| reader.get("CANTRIP_APP_ORIGIN"));
    if hosted && configured.is_none_or(|v| trim(v).is_empty()) {
        return Err(ConfigError::new(
            "Hosted deployments require explicit CANTRIP_APP_ORIGINS.",
        ));
    }
    let input = configured.unwrap_or("http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost,tauri://localhost,capacitor://localhost");
    let values: Vec<_> = input
        .split(',')
        .map(trim)
        .filter(|v| !v.is_empty())
        .collect();
    if values.is_empty() || values.len() > 32 {
        return Err(ConfigError::new(
            "CANTRIP_APP_ORIGINS must contain between 1 and 32 origins.",
        ));
    }
    let mut result = Vec::new();
    for value in values {
        if value.contains('*') {
            return Err(ConfigError::new(
                "CANTRIP_APP_ORIGINS does not allow wildcard origins.",
            ));
        }
        let normalized = if ["tauri://localhost", "capacitor://localhost"].contains(&value) {
            value.into()
        } else {
            let normalized = origin("CANTRIP_APP_ORIGINS", value, false)?;
            let parsed = Url::parse(&normalized).expect("normalized origin");
            let host = parsed
                .host_str()
                .unwrap_or("")
                .trim_matches(['[', ']'])
                .to_lowercase();
            let loopback = host == "localhost"
                || host.ends_with(".localhost")
                || host == "::1"
                || host.starts_with("127.");
            if hosted && parsed.scheme() != "https" && !loopback {
                return Err(ConfigError::new(
                    "Hosted CANTRIP_APP_ORIGINS entries must use HTTPS unless they are loopback origins.",
                ));
            }
            normalized
        };
        if !result.contains(&normalized) {
            result.push(normalized);
        }
    }
    Ok(result)
}

fn number(value: &str) -> Option<f64> {
    let input = trim(value);
    if input.is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] {
        if let Some(digits) = input.to_lowercase().strip_prefix(prefix) {
            return u128::from_str_radix(digits, radix).ok().map(|v| v as f64);
        }
    }
    input.parse().ok()
}

fn proxy_address(value: &str) -> bool {
    if ["linklocal", "loopback", "uniquelocal"].contains(&value) {
        return true;
    }
    let (address, prefix) = value
        .rsplit_once('/')
        .map_or((value, None), |(a, p)| (a, Some(p)));
    let address = if let Some((ip, zone)) = address.split_once('%') {
        if !ip.contains(':')
            || zone.is_empty()
            || !zone
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-.:".contains(&b))
        {
            return false;
        }
        ip
    } else {
        address
    };
    let Ok(address) = address.parse::<IpAddr>() else {
        return false;
    };
    prefix.is_none_or(|p| {
        number(p).is_some_and(|n| {
            n.is_finite()
                && n.fract() == 0.0
                && n >= 0.0
                && n <= if address.is_ipv4() { 32.0 } else { 128.0 }
        })
    })
}

pub(super) fn trusted_proxies(reader: &Reader<'_>, hosted: bool) -> Result<Vec<String>> {
    let proxies: Vec<_> = reader
        .list("CANTRIP_TRUSTED_PROXIES", &[], false)?
        .into_iter()
        .map(|p| p.to_lowercase())
        .collect();
    if proxies.len() > 32 || proxies.iter().any(|p| !proxy_address(p)) {
        return Err(ConfigError::new(
            "CANTRIP_TRUSTED_PROXIES accepts at most 32 IP addresses, CIDR ranges, or loopback/linklocal/uniquelocal aliases.",
        ));
    }
    if hosted && proxies.is_empty() {
        return Err(ConfigError::new(
            "Hosted deployments require explicit CANTRIP_TRUSTED_PROXIES.",
        ));
    }
    let mut result = Vec::new();
    for proxy in proxies {
        if !result.contains(&proxy) {
            result.push(proxy);
        }
    }
    Ok(result)
}

/// Lexical Node path.resolve semantics: no existence or permission probing.
pub(super) fn resolve(cwd: &Path, input: &Path) -> PathBuf {
    #[cfg(windows)]
    let path = {
        if let Some(Component::Prefix(prefix)) = input.components().next() {
            if !input.has_root() {
                let drive = prefix.as_os_str().to_string_lossy();
                let tail: PathBuf = input.components().skip(1).collect();
                let same_drive = cwd
                    .components()
                    .next()
                    .is_some_and(|v| v.as_os_str().to_string_lossy().eq_ignore_ascii_case(&drive));
                if same_drive {
                    cwd.join(tail)
                } else {
                    PathBuf::from(format!("{drive}\\")).join(tail)
                }
            } else {
                input.into()
            }
        } else {
            cwd.join(input)
        }
    };
    #[cfg(not(windows))]
    let path = cwd.join(input);
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other.as_os_str()),
        }
    }
    result
}

// JSON.parse/Object.entries visits canonical array-index keys first, then the
// other keys in insertion order. Key-ring ordering survives the language port.
pub(super) fn entries(object: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let index = |key: &str| {
        key.parse::<u32>()
            .ok()
            .filter(|v| *v < u32::MAX && v.to_string() == key)
    };
    let mut entries: Vec<_> = object.iter().collect();
    entries.sort_by_key(|(key, _)| index(key).map_or((1, 0), |i| (0, i)));
    entries
}
