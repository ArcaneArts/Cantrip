use crate::config::{SameSite, ServerConfig};
use anyhow::{Result, bail};

pub struct CookiePolicy {
    pub name: &'static str,
    pub partitioned_name: Option<&'static str>,
    pub ttl_seconds: u64,
    secure: bool,
    same_site: &'static str,
}

impl CookiePolicy {
    pub fn new(config: &ServerConfig) -> Result<Self> {
        let secure = config.cookie_secure;
        let same_site = match config.cookie_same_site {
            SameSite::Lax => "Lax",
            SameSite::None => "None",
            SameSite::Strict => "Strict",
        };
        if same_site == "None" && !secure {
            bail!("SameSite=None authentication cookies must be Secure.");
        }
        Ok(Self {
            name: if secure {
                "__Host-cantrip_session"
            } else {
                "cantrip_session"
            },
            partitioned_name: if secure && same_site == "None" {
                Some("__Host-cantrip_partitioned_session")
            } else {
                None
            },
            ttl_seconds: config.session_ttl_seconds,
            secure,
            same_site,
        })
    }

    pub fn headers(&self, token: &str, max_age: u64) -> Vec<String> {
        let cookie = |name, partitioned| {
            let mut value = format!(
                "{name}={}; Path=/; HttpOnly; SameSite={}; Max-Age={max_age}",
                encode(token),
                self.same_site
            );
            if self.secure {
                value.push_str("; Secure");
            }
            if partitioned {
                value.push_str("; Partitioned");
            }
            value
        };
        let mut result = vec![cookie(self.name, false)];
        if let Some(name) = self.partitioned_name {
            result.push(cookie(name, true));
        }
        result
    }
    pub fn clear(&self) -> Vec<String> {
        self.headers("", 0)
    }
}

fn encode(input: &str) -> String {
    let mut result = String::new();
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(result, "%{byte:02X}").unwrap();
        }
    }
    result
}

fn decode(input: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut source = input.bytes();
    while let Some(byte) = source.next() {
        if byte == b'%' {
            let hi = (source.next()? as char).to_digit(16)?;
            let lo = (source.next()? as char).to_digit(16)?;
            bytes.push((hi * 16 + lo) as u8);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).ok()
}

pub fn cookie_value(header: Option<&str>, name: &str) -> Option<String> {
    for part in header?.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        if crate::text::trim(key) == name {
            return decode(crate::text::trim(value));
        }
    }
    None
}
