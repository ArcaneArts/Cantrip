//! Bounded input metadata. Native handles never leave the backend.
use crate::target::Bounds;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub reference: String,
    pub role: String,
    pub label: Option<String>,
    pub bounds: Option<Bounds>,
    pub actions: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controls {
    pub controls: Vec<Control>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputReceipt {
    pub method: &'static str,
    pub activation: bool,
    // AX confirms action dispatch, never the user's intended application result.
    pub outcome: &'static str,
}

#[cfg(test)]
mod tests {
    use crate::service::Operation;
    use serde_json::json;
    #[test]
    fn input_contract_uses_worker_camel_case_fields() {
        for operation in ["controls.inspect", "input.press"] {
            let mut value = json!({"operation":operation, "binding":{"sessionId":"s","workerId":"w","chatId":"c","taskId":null,"threadId":null,"turnId":null}, "targetId":"window", "targetGeneration":1});
            if operation == "input.press" {
                value["reference"] = json!("control-1");
            }
            let parsed: Operation = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        }
    }
}
