//! Lazy Git signature verification. The cache keys include the repository,
//! resolved commit and exact Git signing configuration, as in the Node worker.
use super::{GitError, error_message, history, process};
use crate::filesystem::{Scope, paths};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared, WeakShared},
};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
type Job = BoxFuture<'static, std::result::Result<Value, JsString>>;
type Flight = Shared<Job>;
struct Entry {
    expires: u128,
    value: WeakShared<Job>,
    settled: Option<Flight>,
}
impl Entry {
    fn pending(expires: u128, flight: &Flight) -> Self {
        // Active command tasks own the running query. The process-wide cache
        // must not keep subprocess futures alive after their runtime is gone.
        Self {
            expires,
            value: flight.downgrade().unwrap(),
            settled: None,
        }
    }
}
static CACHE: OnceLock<Mutex<IndexMap<String, Entry>>> = OnceLock::new();
fn matches(pattern: &str, text: &str) -> bool {
    regress::Regex::with_flags(pattern, "iu")
        .unwrap()
        .find(text)
        .is_some()
}
fn format(text: &str) -> Option<&'static str> {
    if text.contains("-----BEGIN PGP SIGNATURE-----") {
        Some("gpg")
    } else if text.contains("-----BEGIN SSH SIGNATURE-----") {
        Some("ssh")
    } else if ["SIGNED MESSAGE", "CMS", "PKCS7", "X509"]
        .iter()
        .any(|name| text.contains(&format!("-----BEGIN {name}-----")))
    {
        Some("x509")
    } else if regress::Regex::new("-----BEGIN [^-]+ SIGNATURE-----")
        .unwrap()
        .find(text)
        .is_some()
    {
        Some("unknown")
    } else {
        None
    }
}
pub(super) fn status(code: &str) -> &'static str {
    match code {
        "G" => "valid",
        "U" => "valid-unknown",
        "B" => "invalid",
        "X" | "Y" => "expired",
        "R" => "revoked",
        "N" => "unsigned",
        _ => "unverifiable",
    }
}
pub(super) fn verification(code: &str, message: &str) -> &'static str {
    if code == "N" {
        "not-applicable"
    } else if ["G", "U", "B", "X", "Y", "R"].contains(&code) {
        "available"
    } else if matches("no public key|unknown key|could not find.*key", message) {
        "missing-key"
    } else if matches(
        "allowedsignersfile|allowed signers|principal.*not found",
        message,
    ) {
        "missing-config"
    } else if matches(
        "cannot run|not found|no such file|failed to execute",
        message,
    ) {
        "missing-tool"
    } else {
        "error"
    }
}
pub(super) fn details(
    code: &str,
    signer: &str,
    key: &str,
    fingerprint: &str,
    object: &str,
    message: &str,
) -> Value {
    let format = format(object);
    let code = if code.is_empty() || (code == "N" && format.is_some()) {
        if format.is_some() { "E" } else { "N" }
    } else {
        code
    };
    let status = status(code);
    let message = JsString::from(message).trim();
    let message = JsString::new(message.units().iter().take(10_000).copied().collect());
    let verification = verification(code, &message.lossy());
    json!({"status":status,"signer":(!signer.is_empty()).then_some(signer),"key":(!key.is_empty()).then_some(key),"fingerprint":(!fingerprint.is_empty()).then_some(fingerprint),"format":if status=="unsigned"{None}else{format},"verification":verification,"verificationMessage":(status!="unsigned"&&!message.is_empty()).then_some(message)})
}
async fn load(cwd: &Path, hash: &str, scope: &Scope) -> Result<Value> {
    let show_args = [
        "show",
        "-s",
        "--format=%G?%x00%GS%x00%GK%x00%GF%x00%GG",
        hash,
    ];
    let object_args = ["cat-file", "commit", hash];
    let (verification, object) = tokio::join!(
        process::capture(cwd, &show_args, scope),
        process::raw(cwd, &object_args, scope)
    );
    let verification = verification?;
    if verification.code != Some(0) || verification.overflow {
        bail!("{}", verification.error);
    }
    let text = String::from_utf8_lossy(&verification.bytes);
    let fields: Vec<_> = text
        .trim_end_matches(cantrip_wire::text::whitespace)
        .split('\0')
        .collect();
    let f = |index| fields.get(index).copied().unwrap_or("");
    let stderr = String::from_utf8_lossy(&verification.stderr);
    let message = [f(4), stderr.as_ref()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    checked(
        "gitSignatureSchema",
        &details(
            fields.first().copied().unwrap_or("N"),
            f(1),
            f(2),
            f(3),
            &object?,
            &message,
        ),
    )
}
pub async fn signature(cwd: &Path, revision: &JsString, scope: &Scope) -> Result<Value> {
    let (hash, configuration) = tokio::join!(
        history::resolve(cwd, revision, scope),
        process::raw(
            cwd,
            &[
                "config",
                "--null",
                "--get-regexp",
                "^(gpg\\.|user\\.signingkey$)"
            ],
            scope
        )
    );
    let hash = hash?;
    scope.check()?;
    let context: String = Sha256::digest(configuration.unwrap_or_default().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let absolute = cantrip_config::resolve(&std::env::current_dir()?, cwd);
    let key = format!("{}\0{hash}\0{context}", paths::text(&absolute).lossy());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let cache = CACHE.get_or_init(Mutex::default);
    let flight = {
        let mut cache = cache.lock().unwrap();
        let cached = cache
            .shift_remove(&key)
            .filter(|entry| entry.expires > now)
            .and_then(|entry| entry.value.upgrade().map(|flight| (entry, flight)));
        let (entry, value) = cached.unwrap_or_else(|| {
            while cache.len() >= 256 {
                cache.shift_remove_index(0);
            }
            let cwd = cwd.to_owned();
            let scope = scope.clone();
            let flight = async move {
                load(&cwd, &hash, &scope)
                    .await
                    .map_err(|error| error_message(&error))
            }
            .boxed()
            .shared();
            (Entry::pending(now + 600_000, &flight), flight)
        });
        cache.insert(key.clone(), entry);
        value
    };
    let result = flight.clone().await;
    {
        let mut cache = cache.lock().unwrap();
        if cache
            .get(&key)
            .and_then(|entry| entry.value.upgrade())
            .is_some_and(|value| value.ptr_eq(&flight))
        {
            if result.is_ok() {
                cache.get_mut(&key).unwrap().settled = Some(flight);
            } else {
                cache.shift_remove(&key);
            }
        }
    }
    scope.check()?;
    result.map_err(|message| GitError(message).into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    struct Resource(Arc<AtomicBool>);
    impl Drop for Resource {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn cache_does_not_own_an_abandoned_running_query() {
        let dropped = Arc::new(AtomicBool::new(false));
        let flag = dropped.clone();
        let flight: Flight = async move {
            let _resource = Resource(flag);
            futures::future::pending::<()>().await;
            Ok(Value::Null)
        }
        .boxed()
        .shared();
        let entry = Entry::pending(600_000, &flight);
        let mut caller = Box::pin(flight.clone());
        assert!(futures::poll!(caller.as_mut()).is_pending());
        drop(flight);
        assert!(!dropped.load(Ordering::SeqCst));
        drop(caller);
        assert!(dropped.load(Ordering::SeqCst));
        assert!(entry.value.upgrade().is_none());
        let completed: Flight = async { Ok(Value::Bool(true)) }.boxed().shared();
        let mut entry = Entry::pending(600_000, &completed);
        assert_eq!(completed.clone().await.unwrap(), Value::Bool(true));
        entry.settled = Some(completed);
        assert_eq!(
            entry.value.upgrade().unwrap().await.unwrap(),
            Value::Bool(true)
        );
    }
}
