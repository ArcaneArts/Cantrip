use std::sync::Arc;

use anyhow::{Context, Result};
use argon2::{
    Algorithm, Argon2, Params, Version,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use unicode_normalization::UnicodeNormalization;

pub const DUMMY_PASSWORD_HASH: &str = "$argon2id$v=19$m=65536,t=3,p=1$MUv0/kDJ7VPEN7VQEB4rIQ$wJHg7XVUvZMUi+cUfw0yIUxEbKhWNf/+LiCGElJeOYM";

pub fn normalize_email(email: &str) -> String {
    crate::text::trim(email)
        .nfkc()
        .collect::<String>()
        .to_lowercase()
}

pub fn hash_secret(secret: &str) -> String {
    format!("{:x}", Sha256::digest(secret.as_bytes()))
}
pub fn csrf_token(token: &str) -> String {
    hash_secret(&format!("cantrip-csrf:{token}"))
}

pub fn safe_secret_match(candidate: &str, expected: &str) -> bool {
    let candidate = Sha256::digest(candidate.as_bytes());
    let expected = Sha256::digest(expected.as_bytes());
    bool::from(candidate.ct_eq(&expected))
}

pub fn csrf_matches(expected_hash: &str, candidate: &serde_json::Value) -> bool {
    let Some(candidate) = candidate.as_str().filter(|v| crate::text::length(v) <= 512) else {
        return false;
    };
    // Buffer.from(hex) stops at the first malformed pair and drops an odd tail.
    let expected: Vec<_> = expected_hash
        .as_bytes()
        .chunks_exact(2)
        .map_while(|pair| {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect();
    let actual = Sha256::digest(candidate.as_bytes());
    expected.len() == actual.len() && bool::from(actual.as_slice().ct_eq(&expected))
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes).context("generate authentication entropy")?;
    Ok(bytes)
}

pub struct SessionSecret {
    pub token: String,
    pub token_hash: String,
    pub csrf_token: String,
    pub csrf_token_hash: String,
}
pub fn session_secret() -> Result<SessionSecret> {
    let token = URL_SAFE_NO_PAD.encode(random::<32>()?);
    let csrf_token = csrf_token(&token);
    Ok(SessionSecret {
        token_hash: hash_secret(&token),
        csrf_token_hash: hash_secret(&csrf_token),
        token,
        csrf_token,
    })
}

pub struct MobileCode {
    pub code: String,
    pub code_hash: String,
}
pub fn mobile_code() -> Result<MobileCode> {
    let code = format!("ctms_{}", URL_SAFE_NO_PAD.encode(random::<24>()?));
    Ok(MobileCode {
        code_hash: hash_secret(&code),
        code,
    })
}

/// Password work runs off the async executor, with bounded memory concurrency.
#[derive(Clone)]
pub struct PasswordService {
    permits: Arc<Semaphore>,
}
impl Default for PasswordService {
    fn default() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(4)),
        }
    }
}
impl PasswordService {
    pub async fn hash(&self, password: String) -> Result<String> {
        let permit = self.permits.clone().acquire_owned().await?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let salt = SaltString::encode_b64(&random::<16>()?)?;
            let argon = Argon2::new(
                Algorithm::Argon2id,
                Version::V0x13,
                Params::new(65536, 3, 1, Some(32))?,
            );
            Ok(argon.hash_password(password.as_bytes(), &salt)?.to_string())
        })
        .await
        .context("authentication hashing task")?
    }

    pub async fn verify(&self, encoded: String, password: String) -> bool {
        let Ok(permit) = self.permits.clone().acquire_owned().await else {
            return false;
        };
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            PasswordHash::new(&encoded).is_ok_and(|hash| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &hash)
                    .is_ok()
            })
        })
        .await
        .unwrap_or(false)
    }
}
