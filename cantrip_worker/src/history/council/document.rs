use anyhow::{Context, Result};
use cantrip_wire::{Value, value::json};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};

const DOCUMENT_UNITS: usize = 65_536;

#[derive(Debug)]
pub(crate) struct Document {
    pub id: String,
    pub sequence: i64,
    pub role: String,
    pub source: &'static str,
    pub created_at: String,
    pub text: String,
    pub attachments: Vec<Value>,
    pub truncated: bool,
}

impl Document {
    pub fn open(message: &Value, content: &Value) -> Result<Option<Self>> {
        let mut text = String::new();
        let mut attachments = Vec::new();
        let mut source = "message";
        let mut remaining = DOCUMENT_UNITS;
        let mut truncated = false;
        let mut append = |part: Option<&str>| {
            if let Some(part) = part.filter(|value| !value.trim().is_empty()) {
                if !text.is_empty() && remaining > 0 {
                    text.push('\n');
                    remaining -= 1;
                }
                let clipped = bounded_text(part, remaining);
                truncated |= clipped.len() < part.len();
                remaining -= clipped.encode_utf16().count();
                text.push_str(clipped);
            }
        };
        for item in content.as_array().context("Council history contents")? {
            match item["type"].as_str() {
                Some("text") => append(item["text"].as_str()),
                Some("attachment") => {
                    let file = &item["attachment"];
                    if let (Some(id), Some(name)) = (file["id"].as_str(), file["fileName"].as_str())
                    {
                        source = "attachment";
                        append(Some(name));
                        append(file["previewText"].as_str());
                        attachments.push(json!({"id":id,"name":name}));
                    }
                }
                Some("activity") => {
                    let activity = &item["activity"];
                    if let Some(fields) = activity_fields(activity) {
                        source = "activity";
                        for field in fields {
                            append(activity[*field].as_str());
                        }
                        if activity["type"] == "fileChange" {
                            for change in activity["changes"].as_array().into_iter().flatten() {
                                append(change["path"].as_str());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if text.is_empty() {
            return Ok(None);
        }
        Ok(Some(Self {
            id: message["id"].as_str().context("Council history ID")?.into(),
            sequence: message["sequence"]
                .as_i64()
                .context("Council history sequence")?,
            role: message["role"]
                .as_str()
                .context("Council history role")?
                .into(),
            source,
            created_at: message["createdAt"]
                .as_str()
                .context("Council history creation time")?
                .into(),
            text,
            attachments,
            truncated,
        }))
    }
}

fn activity_fields(activity: &Value) -> Option<&'static [&'static str]> {
    Some(match activity["type"].as_str()? {
        "command" => &["cwd", "outputTail", "output"],
        "fileChange" => &[],
        "worktree" => &["operation", "summary"],
        "plan" => &["text", "explanation"],
        "mcpToolCall" => {
            let tool = activity["tool"]
                .as_str()
                .unwrap_or_default()
                .rsplit("__")
                .next()
                .unwrap_or_default();
            if activity["server"] == "cantrip"
                && (tool.starts_with("council_history_") || tool.starts_with("council_memory_"))
            {
                return None;
            }
            &["server", "tool", "resultText", "error", "errorCode"]
        }
        "nativeItem" if activity["kind"] != "hookPrompt" => &["title", "details"],
        "imageView" => &["path"],
        _ => return None,
    })
}

pub(crate) fn bounded_text(text: &str, units: usize) -> &str {
    let mut remaining = units;
    for (index, character) in text.char_indices() {
        let Some(left) = remaining.checked_sub(character.len_utf16()) else {
            return &text[..index];
        };
        remaining = left;
    }
    text
}

pub(crate) struct Link<'a>(pub &'a str);

impl Link<'_> {
    pub fn evidence(
        &self,
        id: &str,
        sequence: i64,
        role: &str,
        source: &str,
        created: &str,
    ) -> Value {
        let agent = utf8_percent_encode(self.0, NON_ALPHANUMERIC);
        let message = utf8_percent_encode(id, NON_ALPHANUMERIC);
        json!({"agentId":self.0,"messageId":id,"sequence":sequence,"role":role,"source":source,
            "createdAt":created,"link":format!("/?councilAgent={agent}&message={message}")})
    }
}
