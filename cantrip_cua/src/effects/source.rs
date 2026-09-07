//! Trusted local development source. File I/O is performed only on the shader
//! compiler thread, never capture, input, or AppKit queues.
use super::{CONTRACT_VERSION, Configuration};
use serde::Deserialize;
use std::{io::Read, path::Path};

pub const DEVELOPMENT_SHADER_ENV: &str = "CANTRIP_CUA_EFFECT_SHADER";
const MAX_SOURCE_BYTES: u64 = 1024 * 1024;
const METADATA_PREFIX: &str = "// cantrip-effect:";

#[derive(Clone, Debug, PartialEq)]
pub struct ShaderSource {
    pub text: String,
    pub label: String,
    pub fragment: String,
    pub continuous: bool,
    pub history: bool,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    contract_version: Option<u32>,
    fragment: Option<String>,
    continuous: Option<bool>,
    history: Option<bool>,
}
impl ShaderSource {
    pub fn bundled(configuration: &Configuration, text: &str) -> Self {
        let descriptor = configuration.descriptor();
        Self {
            text: text.into(),
            label: "bundled-effects.metal".into(),
            fragment: descriptor.fragment.into(),
            continuous: descriptor.continuous,
            history: descriptor.history,
        }
    }
    pub fn read(path: &Path, configuration: &Configuration) -> Result<Self, String> {
        // Read the actual source instead of using permission or metadata guesses.
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .and_then(|file| file.take(MAX_SOURCE_BYTES + 1).read_to_end(&mut bytes))
            .map_err(|error| format!("Could not read shader {}: {error}", path.display()))?;
        if bytes.len() as u64 > MAX_SOURCE_BYTES {
            return Err(format!(
                "Shader {} exceeds the 1 MiB development-source limit",
                path.display()
            ));
        }
        let text = String::from_utf8(bytes)
            .map_err(|error| format!("Shader {} is not UTF-8: {error}", path.display()))?;
        Self::parse(configuration, text, path.to_string_lossy().into_owned())
    }
    pub fn parse(
        configuration: &Configuration,
        text: String,
        label: String,
    ) -> Result<Self, String> {
        let mut metadata = Metadata::default();
        let mut seen = false;
        for (index, line) in text.lines().enumerate() {
            if let Some(json) = line.trim().strip_prefix(METADATA_PREFIX) {
                if seen {
                    return Err(format!(
                        "{label}:{}: duplicate cantrip-effect metadata",
                        index + 1
                    ));
                }
                seen = true;
                metadata = serde_json::from_str(json).map_err(|error| {
                    format!(
                        "{label}:{}: invalid cantrip-effect metadata: {error}",
                        index + 1
                    )
                })?;
            }
        }
        if metadata
            .contract_version
            .is_some_and(|version| version != CONTRACT_VERSION)
        {
            return Err(format!(
                "{label}: shader contract version must be {CONTRACT_VERSION}"
            ));
        }
        let descriptor = configuration.descriptor();
        let fragment = metadata
            .fragment
            .unwrap_or_else(|| descriptor.fragment.into());
        if fragment.is_empty()
            || fragment.len() > 128
            || !fragment
                .bytes()
                .enumerate()
                .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
        {
            return Err(format!(
                "{label}: fragment must be a Metal function identifier"
            ));
        }
        Ok(Self {
            text,
            label,
            fragment,
            continuous: metadata.continuous.unwrap_or(descriptor.continuous),
            history: metadata.history.unwrap_or(descriptor.history),
        })
    }
    pub fn compilation_source(&self, contract: &str) -> String {
        // Reset line numbering after the injected ABI so Metal diagnostics point
        // directly into the user's file, including its unchanged metadata line.
        let label = serde_json::to_string(&self.label).unwrap();
        format!("{contract}\n#line 1 {label}\n{}", self.text)
    }
}

/// Keep compiler diagnostics inside ordinary native metadata limits so a bad
/// shader cannot turn an effect error into a framing failure of the CUA helper.
pub fn diagnostic(mut message: String) -> String {
    const LIMIT: usize = 16 * 1024;
    if message.len() > LIMIT {
        let mut end = LIMIT;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
        message.push_str("\n[Further shader diagnostics truncated]");
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    fn configuration() -> Configuration {
        Configuration {
            effect: super::super::EffectId::DebugGradient,
            ..Default::default()
        }
    }
    #[test]
    fn diagnostics_are_bounded_without_breaking_utf8() {
        let value = diagnostic("λ".repeat(20_000));
        assert!(value.len() < 17_000);
        assert!(value.ends_with("[Further shader diagnostics truncated]"));
    }
    #[test]
    fn development_metadata_controls_entry_animation_and_history() {
        let source = ShaderSource::parse(&configuration(), "// cantrip-effect: {\"contractVersion\":1,\"fragment\":\"my_effect\",\"continuous\":false,\"history\":true}\nfragment half4 my_effect() { return 1; }".into(), "test.metal".into()).unwrap();
        assert_eq!(source.fragment, "my_effect");
        assert!(!source.continuous);
        assert!(source.history);
        assert!(
            source
                .compilation_source("ABI")
                .starts_with("ABI\n#line 1 \"test.metal\"\n")
        );
    }
    #[test]
    fn actionable_metadata_errors_and_descriptor_defaults() {
        for json in [
            "{\"contractVersion\":2}",
            "{\"fragment\":\"a b\"}",
            "{\"unknown\":true}",
            "broken",
        ] {
            let error = ShaderSource::parse(
                &configuration(),
                format!("// cantrip-effect: {json}"),
                "broken.metal".into(),
            )
            .unwrap_err();
            assert!(error.contains("broken.metal"));
        }
        let source =
            ShaderSource::parse(&configuration(), "fragment".into(), "test".into()).unwrap();
        assert_eq!(source.fragment, "cantrip_debug_gradient");
        assert!(source.continuous);
        assert!(!source.history);
    }
    #[test]
    fn actual_file_edits_and_missing_files_are_observed() {
        let path = std::env::temp_dir().join(format!(
            "cantrip-effect-source-{}-{}.metal",
            std::process::id(),
            super::super::now_ns()
        ));
        std::fs::write(&path, "first").unwrap();
        let first = ShaderSource::read(&path, &configuration()).unwrap();
        std::fs::write(&path, "second").unwrap();
        assert_ne!(first, ShaderSource::read(&path, &configuration()).unwrap());
        std::fs::remove_file(&path).unwrap();
        assert!(
            ShaderSource::read(&path, &configuration())
                .unwrap_err()
                .contains("Could not read shader")
        );
    }
}
