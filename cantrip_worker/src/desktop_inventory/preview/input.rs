//! Check native receipts against the chosen action and pre-dispatch cursor.
use anyhow::{Result, ensure};
use cantrip_wire::{Value, value::json};

pub(super) struct Expected {
    method: &'static str,
    activation: Option<bool>,
    position: Value,
}

impl Expected {
    pub(super) fn new(action: &Value, before: &Value, backend: &str) -> Option<Self> {
        let method = method(action, backend)?;
        let cursor = &before["cursor"]["position"];
        let command = &action["command"];
        let kind = command["kind"].as_str();
        let no_position = Value::Null;
        let position = match (action["operation"].as_str(), kind) {
            (Some("input.press"), _) | (_, Some("focus" | "window-input" | "media")) => {
                &no_position
            }
            (_, Some("timeline")) => command["frames"]
                .as_array()
                .and_then(|frames| {
                    frames
                        .iter()
                        .rev()
                        .find_map(|frame| frame.get("pointerDown"))
                })
                .unwrap_or(cursor),
            (_, Some("prepared-press" | "scroll")) => command.get("point").unwrap_or(cursor),
            (_, Some("move")) => &command["point"],
            (_, Some("drag")) => &command["end"],
            (Some("input.click"), _) => action.get("position").unwrap_or(cursor),
            _ => cursor,
        }
        .clone();
        let activation = kind.and_then(|kind| match kind {
            "focus" | "window-input" => None,
            "timeline" => Some(command["frames"].as_array().is_some_and(|frames| {
                frames.iter().any(|frame| {
                    frame.get("pointerDown").is_some()
                        && frame["pointerModifiers"]
                            .as_array()
                            .is_some_and(Vec::is_empty)
                })
            })),
            "prepared-press" | "drag" => Some(true),
            _ => Some(false),
        });
        Some(Self {
            method,
            activation,
            position,
        })
    }

    pub(super) fn validate(&self, input: &Value) -> Result<()> {
        let uncertain_delivery =
            self.method == "process-coordinate" || self.method.starts_with("background-");
        let outcome_valid = if uncertain_delivery {
            input["windowDelivery"] == "unverified"
        } else {
            input.get("windowDelivery").is_none()
                && (self.method == "system-media" || input["outcome"] == "dispatched")
        };
        ensure!(
            input["method"] == self.method
                && self
                    .activation
                    .is_none_or(|expected| input["activation"] == expected)
                && (!matches!(
                    self.method,
                    "focus" | "window-input" | "background-prepared-press"
                ) || input["activation"] == true)
                && outcome_valid
                && (self.method != "system-media"
                    || (input.get("position").is_none() && input.get("globalPosition").is_none()))
                && (self.position.is_null()
                    || (input["position"] == self.position
                        && input.get("globalPosition").is_some())),
            "The native receipt does not confirm the requested computer input."
        );
        Ok(())
    }
}

pub(super) fn method(action: &Value, backend: &str) -> Option<&'static str> {
    match action["operation"].as_str()? {
        "input.press" => Some("accessibility"),
        "input.click" => Some(match action["delivery"].as_str() {
            Some("background") => "background-coordinate",
            Some("process") => "process-coordinate",
            _ if backend == "linux-x11" || action["globalInput"] == true => "coordinate",
            _ => "accessibility",
        }),
        "input.perform" => Some(match action["command"]["kind"].as_str()? {
            "focus" => "focus",
            "window-input" => "window-input",
            "media" => "system-media",
            "prepared-press" => "background-prepared-press",
            "timeline" => "background-timeline",
            "text" => "background-text",
            "key" => "background-key",
            "move" => "background-move",
            "drag" => "background-drag",
            "scroll" => "background-scroll",
            _ => return None,
        }),
        _ => None,
    }
}

pub(super) fn failed_receipt(
    method: &str,
    position: &Value,
    code: Option<&str>,
    outcome: &str,
) -> Value {
    let activation = match method {
        "coordinate" | "background-drag" | "background-timeline" => Value::Null,
        "focus" | "window-input" | "background-prepared-press" => json!(true),
        _ => json!(false),
    };
    let mut result = json!({"method":method,"activation":activation,"outcome":outcome});
    if code.is_some_and(|code| {
        matches!(
            code,
            "unsupported"
                | "control-not-found"
                | "control-ambiguous"
                | "control-inspection-incomplete"
        )
    }) {
        result["outcome"] = json!("unsupported");
    }
    if !position.is_null() {
        result["position"] = position.clone();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::checked;

    #[test]
    fn accepts_only_the_confirmed_click_delivery_and_coordinates() -> Result<()> {
        let point = json!({"x":20,"y":30});
        let click = json!({"operation":"input.click","delivery":"process","position":point});
        let expected = Expected::new(&click, &Value::Null, "macos").unwrap();
        let receipt = json!({
            "method":"process-coordinate","activation":false,"outcome":"unknown",
            "windowDelivery":"unverified","position":point,
            "globalPosition":json!({"x":44,"y":62}),
        });
        expected.validate(&receipt)?;
        for (field, replacement) in [
            ("method", json!("coordinate")),
            ("windowDelivery", Value::Null),
            ("globalPosition", Value::Null),
            ("position", json!({"x":25,"y":30})),
        ] {
            let mut wrong = receipt.clone();
            if replacement.is_null() {
                let Value::Object(fields) = &mut wrong else {
                    unreachable!()
                };
                fields.shift_remove(field);
            } else {
                wrong[field] = replacement;
            }
            assert!(expected.validate(&wrong).is_err(), "{field}");
        }
        Ok(())
    }

    #[test]
    fn timeline_uses_normalized_keys_and_requires_balanced_frames() -> Result<()> {
        let action = |key| {
            json!({
                "operation":"input.perform","sessionId":"session","targetId":"window","targetGeneration":1,
                "command":json!({"kind":"timeline","frames":vec![
                    json!({"atMs":0,"keyDown":["a"],"pointerDown":json!({"x":20,"y":30})}),
                    json!({"atMs":90_000,"keyUp":[key],"pointerUp":true}),
                ]})
            })
        };
        let schema = "computerUseNativePreviewActionSchema";
        let timeline = checked(schema, &action("A"))?;
        let frames = timeline["command"]["frames"].as_array().unwrap();
        assert_eq!(frames[0]["keyDown"], json!(["A"]));
        assert_eq!(frames[0]["pointerModifiers"], json!(Vec::<Value>::new()));
        assert!(checked(schema, &action("B")).is_err());
        let expected = Expected::new(&timeline, &Value::Null, "macos").unwrap();
        assert_eq!(expected.method, "background-timeline");
        assert_eq!(expected.activation, Some(true));
        assert_eq!(expected.position, json!({"x":20,"y":30}));
        Ok(())
    }
}
