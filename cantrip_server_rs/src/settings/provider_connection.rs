//! Public probe failures retain Source precedence and JavaScript string semantics.
use crate::wire::JsString;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureStage {
    WorkerPlacement,
    CodexStartup,
    KeyAuthentication,
    ModelAvailability,
    EndpointCompatibility,
    ProviderResponse,
}
impl FailureStage {
    pub fn name(self) -> &'static str {
        match self {
            Self::WorkerPlacement => "worker-placement",
            Self::CodexStartup => "codex-startup",
            Self::KeyAuthentication => "key-authentication",
            Self::ModelAvailability => "model-availability",
            Self::EndpointCompatibility => "endpoint-compatibility",
            Self::ProviderResponse => "provider-response",
        }
    }
    pub fn message(self, detail: &JsString) -> JsString {
        self.message_with_provider(detail, None)
    }
    pub fn message_with_provider(self, detail: &JsString, provider: Option<&str>) -> JsString {
        static STATUS: OnceLock<regress::Regex> = OnceLock::new();
        static REFUSED: OnceLock<regress::Regex> = OnceLock::new();
        static DNS: OnceLock<regress::Regex> = OnceLock::new();
        static TIMEOUT: OnceLock<regress::Regex> = OnceLock::new();
        static CONTEXT: OnceLock<regress::Regex> = OnceLock::new();
        static TLS: OnceLock<regress::Regex> = OnceLock::new();
        let provider = provider.filter(|name| !name.is_empty());
        let prefix = match (self, provider) {
            (Self::WorkerPlacement, _) => {
                "No compatible online worker could run the test.".to_owned()
            }
            (Self::CodexStartup, _) => {
                "The selected worker could not start bundled Codex.".to_owned()
            }
            (Self::KeyAuthentication, Some(name)) => format!("{name} rejected authentication."),
            (Self::EndpointCompatibility, Some(name)) => {
                format!("{name}'s Responses endpoint was unavailable or incompatible.")
            }
            (Self::ModelAvailability, Some(name)) => {
                format!("The requested {name} model was unavailable.")
            }
            (Self::ProviderResponse, Some(name)) => {
                format!("{name} returned an unsuccessful provider response.")
            }
            (Self::KeyAuthentication, None) => "Z.ai rejected the Coding Plan API key.".to_owned(),
            (Self::ModelAvailability, None) => {
                "No usable Z.ai Coding Plan model was available.".to_owned()
            }
            (Self::EndpointCompatibility, None) => {
                "The Z.ai Responses endpoint was unavailable or incompatible.".to_owned()
            }
            (Self::ProviderResponse, None) => {
                "Z.ai returned an unsuccessful provider response.".to_owned()
            }
        };
        let status = STATUS
            .get_or_init(|| {
                regress::Regex::with_flags(
                    r"(?:http(?:\/[\d.]+)?(?:\s+status)?|status)\s*[:=]?\s*(\d{3})",
                    "i",
                )
                .expect("provider HTTP status diagnostic")
            })
            .find_from_ucs2(detail.units(), 0)
            .next()
            .and_then(|found| found.captures.first().cloned().flatten())
            .map(|range| String::from_utf16_lossy(&detail.units()[range]));
        let normalized = detail.lowercase();
        let reason = if diagnostic(&REFUSED, r"econnrefused|connection refused", &normalized) {
            Some("The connection was refused.")
        } else if diagnostic(
            &DNS,
            r"enotfound|eai_again|dns|name resolution",
            &normalized,
        ) {
            Some("The endpoint hostname could not be resolved.")
        } else if diagnostic(&TIMEOUT, r"timed?\s*out|timeout", &normalized) {
            Some("The request timed out.")
        } else if diagnostic(
            &CONTEXT,
            r"context.{0,40}(exceed|length|limit)|maximum.{0,20}context",
            &normalized,
        ) {
            Some("The model rejected the request's context size.")
        } else if diagnostic(&TLS, r"certificate|tls|ssl", &normalized) {
            Some("The secure connection failed.")
        } else {
            None
        };
        let mut parts = vec![prefix];
        if let Some(status) = status {
            parts.push(format!("HTTP {status}."));
        }
        if let Some(reason) = reason {
            parts.push(reason.to_owned());
        }
        parts.join(" ").into()
    }
}
fn diagnostic(pattern: &'static OnceLock<regress::Regex>, source: &str, value: &JsString) -> bool {
    pattern
        .get_or_init(|| regress::Regex::new(source).expect("provider diagnostic pattern"))
        .find_from_ucs2(value.units(), 0)
        .next()
        .is_some()
}
pub fn failure_stage(message: &JsString) -> FailureStage {
    let lower = message.lowercase();
    let contains = |s: &str| {
        let pattern = s.encode_utf16().collect::<Vec<_>>();
        lower.units().windows(pattern.len()).any(|v| v == pattern)
    };
    if contains("worker")
        && ["offline", "not found", "not available"]
            .iter()
            .any(|s| contains(s))
    {
        FailureStage::WorkerPlacement
    } else if [
        "app-server",
        "codex runtime",
        "codex binary",
        "before listening",
        "spawn codex",
    ]
    .iter()
    .any(|s| contains(s))
    {
        FailureStage::CodexStartup
    } else if [
        "401",
        "403",
        "unauthorized",
        "forbidden",
        "api key",
        "authentication",
    ]
    .iter()
    .any(|s| contains(s))
    {
        FailureStage::KeyAuthentication
    } else if [
        "model not found",
        "unknown model",
        "unsupported model",
        "model unavailable",
        "no enabled z.ai model",
    ]
    .iter()
    .any(|s| contains(s))
    {
        FailureStage::ModelAvailability
    } else if ["404", "responses endpoint", "endpoint", "wire api"]
        .iter()
        .any(|s| contains(s))
    {
        FailureStage::EndpointCompatibility
    } else {
        FailureStage::ProviderResponse
    }
}
