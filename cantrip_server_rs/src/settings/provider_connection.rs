//! Public probe failures retain Source precedence and JavaScript string semantics.
use crate::wire::JsString;

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
        let prefix = match self {
            Self::WorkerPlacement => "No compatible online worker could run the test.",
            Self::CodexStartup => "The selected worker could not start bundled Codex.",
            Self::KeyAuthentication => "Z.ai rejected the Coding Plan API key.",
            Self::ModelAvailability => "No usable Z.ai Coding Plan model was available.",
            Self::EndpointCompatibility => {
                "The Z.ai Responses endpoint was unavailable or incompatible."
            }
            Self::ProviderResponse => "Z.ai returned an unsuccessful provider response.",
        };
        let mut result = prefix.encode_utf16().collect::<Vec<_>>();
        let trimmed = detail.trim();
        if !trimmed.is_empty() {
            result.push(32);
            result.extend_from_slice(trimmed.units());
        }
        JsString::new(result)
    }
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
