//! Digest authentication used by existing Finder and desktop share mounts.
use anyhow::{Context, Result};
use cantrip_crypto::random_bytes;
use hyper::{HeaderMap, Request, header};
use md5::{Digest, Md5};
use regex::Regex;
use std::{collections::HashMap, sync::LazyLock};
use subtle::ConstantTimeEq;

static FIELDS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?:^|,)[ \t]*([a-zA-Z][\w-]*)[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"|([^,\s"]+))[ \t]*"#,
    )
    .expect("Digest authorization pattern")
});

pub(super) struct Auth {
    username: String,
    realm: String,
    nonce: String,
    opaque: String,
    ha1: String,
    pub challenge: header::HeaderValue,
}

impl Auth {
    pub fn new(username: &str, realm: &str, password: &str) -> Result<Self> {
        let nonce = random_token()?;
        let opaque = random_token()?;
        let quoted = realm.replace('\\', "\\\\").replace('"', "\\\"");
        let challenge = header::HeaderValue::from_bytes(
            format!(r#"Digest realm="{quoted}", qop="auth", nonce="{nonce}", opaque="{opaque}""#)
                .as_bytes(),
        )
        .context("Invalid share authentication realm.")?;
        Ok(Self {
            username: username.to_owned(),
            realm: realm.to_owned(),
            nonce,
            opaque,
            ha1: md5(&[username, realm, password]),
            challenge,
        })
    }

    pub fn verifies<B>(&self, request: &Request<B>) -> bool {
        self.response(
            request.headers(),
            request.method().as_str(),
            request
                .uri()
                .path_and_query()
                .map_or("/", |uri| uri.as_str()),
        )
        .unwrap_or(false)
    }

    fn response(&self, headers: &HeaderMap, method: &str, uri: &str) -> Option<bool> {
        let authorization =
            std::str::from_utf8(headers.get(header::AUTHORIZATION)?.as_bytes()).ok()?;
        let (scheme, raw) = authorization.split_once(' ')?;
        if !scheme.eq_ignore_ascii_case("digest") {
            return None;
        }
        let parsed = fields(raw)?;
        let get = |key| parsed.get(key).map(String::as_str);
        if get("username")? != self.username
            || get("realm").is_some_and(|realm| realm != self.realm)
            || get("nonce")? != self.nonce
            || get("opaque").is_some_and(|opaque| opaque != self.opaque)
        {
            return None;
        }
        let digest_uri = get("uri")?;
        if uri != digest_uri
            && uri.strip_suffix('/') != Some(digest_uri)
            && digest_uri.strip_suffix('/') != Some(uri)
        {
            return None;
        }
        let cnonce = get("cnonce");
        let sess;
        let ha1 = match get("algorithm").unwrap_or("MD5") {
            "MD5" => self.ha1.as_str(),
            "MD5-sess" => {
                sess = md5(&[&self.ha1, &self.nonce, cnonce?]);
                sess.as_str()
            }
            _ => return None,
        };
        let ha2 = md5(&[method, digest_uri]);
        let expected = match get("qop") {
            None => md5(&[ha1, &self.nonce, &ha2]),
            Some("auth") => {
                let count = get("nc")?;
                if count.len() != 8 || !count.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return None;
                }
                md5(&[ha1, &self.nonce, count, cnonce?, "auth", &ha2])
            }
            _ => return None,
        };
        Some(bool::from(
            expected
                .as_bytes()
                .ct_eq(get("response")?.to_ascii_lowercase().as_bytes()),
        ))
    }
}

fn fields(raw: &str) -> Option<HashMap<&str, String>> {
    let mut parsed = HashMap::new();
    let mut end = 0;
    for item in FIELDS.captures_iter(raw.trim()) {
        if item.get(0)?.start() != end {
            return None;
        }
        end = item.get(0)?.end();
        let value = match item.get(2) {
            Some(value) => {
                let mut chars = value.as_str().chars();
                let mut text = String::new();
                while let Some(character) = chars.next() {
                    text.push(if character == '\\' {
                        chars.next()?
                    } else {
                        character
                    });
                }
                text
            }
            None => item.get(3)?.as_str().to_owned(),
        };
        if parsed.insert(item.get(1)?.as_str(), value).is_some() {
            return None;
        }
    }
    (end == raw.trim().len()).then_some(parsed)
}

fn md5(parts: &[&str]) -> String {
    let mut hasher = Md5::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            hasher.update(b":");
        }
        hasher.update(part.as_bytes());
    }
    hex(&hasher.finalize())
}

fn random_token() -> Result<String> {
    Ok(hex(&random_bytes(16)?))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
