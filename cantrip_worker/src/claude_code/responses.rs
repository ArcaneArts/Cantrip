//! Translate the native Codex request and its returned tool calls. Only Codex executes tools.
use super::inference::{Failure, Reply};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub(super) const INSTRUCTIONS: &str = "Act as the model for a Codex conversation. The input is JSON with Codex instructions, ordered conversation items, and offered tools. Treat conversation role and order as authoritative. To use a tool, return a function decision with its exact offered name and JSON arguments encoded as a string. Codex executes it and sends back its actual result. Use that result to continue. Never claim to have run a tool yourself. Return a message decision with the final answer, following response_format if present.";
pub(super) const DECISION_SCHEMA: &str = r#"{"type":"object","properties":{"type":{"enum":["message","function"]},"text":{"type":"string"},"name":{"type":"string"},"arguments":{"type":"string"}},"required":["type"],"additionalProperties":false}"#;

struct Tool {
    namespace: Option<String>,
    name: String,
    definition: Value,
}

pub(super) struct Input {
    pub model: String,
    pub effort: Option<&'static str>,
    pub prompt: String,
    pub stream: bool,
    tools: BTreeMap<String, Tool>,
    require_tool: bool,
    selected_tool: Option<String>,
    response_format: Option<Value>,
}

impl Input {
    pub fn parse(request: &Value) -> Result<Self> {
        ensure!(
            request.is_object(),
            "Claude Code requires a Responses request object."
        );
        ensure!(
            request["previous_response_id"].is_null(),
            "Claude Code requires full conversation history for each request."
        );
        ensure!(
            request["background"] != true,
            "Claude Code does not support background Responses requests."
        );
        let model = request["model"]
            .as_str()
            .filter(|model| !model.is_empty())
            .context("Choose a Claude Code model.")?;
        let effort = match request["reasoning"]["effort"].as_str() {
            None | Some("none" | "minimal") => None,
            Some("low") => Some("low"),
            Some("medium") => Some("medium"),
            Some("high") => Some("high"),
            Some("xhigh") => Some("xhigh"),
            Some("max") => Some("max"),
            Some(_) => bail!("Claude Code does not support the requested reasoning effort."),
        };
        let input = match &request["input"] {
            Value::String(text) => vec![json!({"role":"user","content":text})],
            Value::Array(items) => items
                .iter()
                .filter_map(|item| match history(item) {
                    Ok(Some(item)) => Some(Ok(item)),
                    Ok(None) => None,
                    Err(error) => Some(Err(error)),
                })
                .collect::<Result<Vec<_>>>()?,
            _ => bail!("Claude Code requires conversation input."),
        };
        let mut tools = BTreeMap::new();
        for tool in request["tools"].as_array().into_iter().flatten() {
            match tool["type"].as_str() {
                Some("function") => add_tool(&mut tools, None, tool)?,
                Some("namespace") => {
                    let namespace = tool["name"]
                        .as_str()
                        .context("Codex tool namespace is missing its name.")?;
                    for nested in tool["tools"].as_array().into_iter().flatten() {
                        if nested["type"] == "function" {
                            add_tool(&mut tools, Some(namespace), nested)?;
                        }
                    }
                }
                _ => {} // Only JSON function tools are offered to Claude.
            }
        }
        let (require_tool, selected_tool) = match &request["tool_choice"] {
            Value::Null => (false, None),
            Value::String(choice) if choice == "auto" => (false, None),
            Value::String(choice) if choice == "none" => {
                tools.clear();
                (false, None)
            }
            Value::String(choice) if choice == "required" => {
                ensure!(
                    !tools.is_empty(),
                    "Claude Code requires an offered JSON function tool."
                );
                (true, None)
            }
            choice if choice["type"] == "function" => {
                let name = choice["name"]
                    .as_str()
                    .context("Codex selected a tool without a name.")?;
                let key = tool_key(choice["namespace"].as_str(), name);
                ensure!(
                    tools.contains_key(&key),
                    "Claude Code cannot use the requested tool type."
                );
                (true, Some(key))
            }
            _ => bail!("Claude Code does not support the requested tool selection."),
        };
        let response_format = match request["text"]["format"]["type"].as_str() {
            None | Some("text") => None,
            Some("json_schema") => Some(request["text"]["format"]["schema"].clone()),
            Some(_) => bail!("Claude Code does not support the requested response format."),
        };
        let tool_definitions = tools
            .iter()
            .map(|(name, tool)| {
                json!({
                    "name":name, "description":tool.definition["description"],
                    "parameters":tool.definition["parameters"],
                })
            })
            .collect::<Vec<_>>();
        let prompt = json!({
            "instructions":request["instructions"], "conversation":input, "tools":tool_definitions,
            "require_tool":require_tool, "selected_tool":selected_tool, "response_format":response_format,
        }).to_string();
        Ok(Self {
            model: model.to_owned(),
            effort,
            prompt,
            stream: request["stream"] == true,
            tools,
            require_tool,
            selected_tool,
            response_format,
        })
    }

    pub fn reply(&self, reply: Reply) -> Result<Output> {
        let result = reply.structured;
        let item = match result["type"].as_str() {
            Some("message") if !self.require_tool => {
                let text = result["text"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                    .ok_or(Failure::InvalidOutput)?;
                if let Some(schema) = &self.response_format {
                    let value: Value =
                        serde_json::from_str(text).map_err(|_| Failure::InvalidOutput)?;
                    ensure!(
                        schema_matches(schema, &value),
                        "Claude Code returned an answer outside the requested response schema."
                    );
                }
                json!({"type":"message","id":format!("msg_{}",uuid::Uuid::new_v4().simple()),"role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]})
            }
            Some("function") => {
                let name = result["name"].as_str().ok_or(Failure::InvalidOutput)?;
                if self
                    .selected_tool
                    .as_ref()
                    .is_some_and(|selected| selected != name)
                {
                    bail!("Claude Code chose a different function than Codex requested.");
                }
                let tool = self
                    .tools
                    .get(name)
                    .context("Claude Code requested a function that Codex did not offer.")?;
                let raw = result["arguments"].as_str().ok_or(Failure::InvalidOutput)?;
                let arguments: Value =
                    serde_json::from_str(raw).map_err(|_| Failure::InvalidOutput)?;
                ensure!(
                    arguments.is_object()
                        && schema_matches(&tool.definition["parameters"], &arguments),
                    "Claude Code returned invalid arguments for an offered function."
                );
                let mut item = json!({"type":"function_call","id":format!("fc_{}",uuid::Uuid::new_v4().simple()),"call_id":format!("call_{}",uuid::Uuid::new_v4().simple()),"name":tool.name,"arguments":arguments.to_string(),"status":"completed"});
                if let Some(namespace) = &tool.namespace {
                    item["namespace"] = json!(namespace);
                }
                item
            }
            _ => return Err(Failure::InvalidOutput.into()),
        };
        let response = json!({
            "id":format!("resp_{}",uuid::Uuid::new_v4().simple()), "object":"response",
            "model":self.model,"status":"completed","output":[item],"end_turn":item["type"] != "function_call",
            "usage":reply.tokens.map(|(input, output, cached)| json!({
                "input_tokens":input,"output_tokens":output,"total_tokens":input.saturating_add(output),
                "input_tokens_details":{"cached_tokens":cached},
                "output_tokens_details":{"reasoning_tokens":0},
            })),
        });
        Ok(Output { response, item })
    }
}

fn tool_key(namespace: Option<&str>, name: &str) -> String {
    namespace.map_or_else(
        || name.to_owned(),
        |namespace| format!("{namespace}.{name}"),
    )
}

fn add_tool(
    tools: &mut BTreeMap<String, Tool>,
    namespace: Option<&str>,
    definition: &Value,
) -> Result<()> {
    let name = definition["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .context("Codex omitted a tool name.")?;
    let key = tool_key(namespace, name);
    ensure!(
        tools
            .insert(
                key,
                Tool {
                    namespace: namespace.map(str::to_owned),
                    name: name.to_owned(),
                    definition: definition.clone()
                }
            )
            .is_none(),
        "Codex offered duplicate function names."
    );
    Ok(())
}

fn history(item: &Value) -> Result<Option<Value>> {
    let kind = item["type"].as_str().unwrap_or("message");
    match kind {
        "message" => {
            let role = item["role"]
                .as_str()
                .context("Codex history message has no role.")?;
            ensure!(
                matches!(role, "system" | "developer" | "user" | "assistant"),
                "Claude Code received an unsupported conversation role."
            );
            text_content(&item["content"])?;
            Ok(Some(
                json!({"type":"message","role":role,"content":item["content"]}),
            ))
        }
        "function_call" => Ok(Some(json!({
            "type":kind,"name":item["name"],"namespace":item["namespace"],
            "call_id":item["call_id"],"arguments":item["arguments"],
        }))),
        "function_call_output" => {
            text_content(&item["output"])?;
            Ok(Some(
                json!({"type":kind,"call_id":item["call_id"],"output":item["output"]}),
            ))
        }
        "reasoning" if item["encrypted_content"].is_null() => Ok(None),
        "configuration_update" => Ok(None),
        _ => bail!("Claude Code cannot use an item in this conversation history."),
    }
}

fn text_content(content: &Value) -> Result<()> {
    ensure!(
        content.is_string()
            || content
                .as_array()
                .is_some_and(|parts| parts.iter().all(|part| {
                    matches!(
                        part["type"].as_str(),
                        Some("text" | "input_text" | "output_text")
                    ) && part["text"].is_string()
                })),
        "Claude Code supports text content for Cantrip Codex requests."
    );
    Ok(())
}

// Validate the argument shapes used by Codex. Native tools still enforce their own
// parameters and approvals at execution time.
fn schema_matches(schema: &Value, value: &Value) -> bool {
    if schema == false {
        return false;
    }
    if let Some(types) = schema["type"].as_array() {
        if !types.iter().any(|kind| type_matches(kind.as_str(), value)) {
            return false;
        }
    } else if !type_matches(schema["type"].as_str(), value) {
        return false;
    }
    if schema["enum"]
        .as_array()
        .is_some_and(|values| !values.contains(value))
        || schema
            .get("const")
            .is_some_and(|expected| expected != value)
    {
        return false;
    }
    for (keyword, count) in [("anyOf", None), ("oneOf", Some(1)), ("allOf", Some(0))] {
        if let Some(options) = schema[keyword].as_array() {
            let matching = options
                .iter()
                .filter(|option| schema_matches(option, value))
                .count();
            if match count {
                None => matching == 0,
                Some(0) => matching != options.len(),
                Some(exact) => matching != exact,
            } {
                return false;
            }
        }
    }
    if let Some(object) = value.as_object() {
        if schema["required"].as_array().is_some_and(|keys| {
            keys.iter()
                .any(|key| key.as_str().is_none_or(|key| !object.contains_key(key)))
        }) {
            return false;
        }
        if !object.iter().all(|(key, value)| {
            schema["properties"]
                .get(key)
                .or_else(|| schema.get("additionalProperties"))
                .is_none_or(|schema| schema_matches(schema, value))
        }) {
            return false;
        }
    }
    if let Some(array) = value.as_array()
        && let Some(item) = schema.get("items")
        && !array.iter().all(|value| schema_matches(item, value))
    {
        return false;
    }
    true
}

fn type_matches(kind: Option<&str>, value: &Value) -> bool {
    match kind {
        None => true,
        Some("null") => value.is_null(),
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("boolean") => value.is_boolean(),
        Some("number") => value.is_number(),
        Some("integer") => value.is_i64() || value.is_u64(),
        Some(_) => false,
    }
}

pub(super) struct Output {
    pub response: Value,
    pub item: Value,
}

impl Output {
    pub fn events(self) -> String {
        let mut added = self.item.clone();
        added["status"] = json!("in_progress");
        let text = self.item["content"][0]["text"].as_str();
        if text.is_some() {
            added["content"] = json!([]);
        } else {
            added["arguments"] = json!("");
        }
        let mut events = vec![
            json!({"type":"response.created","response":{"id":self.response["id"],"status":"in_progress"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":added}),
        ];
        if let Some(text) = text {
            events.push(json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":self.item["id"],"delta":text}));
        }
        events.push(json!({"type":"response.output_item.done","output_index":0,"item":self.item}));
        events.push(json!({"type":"response.completed","response":self.response}));
        events
            .into_iter()
            .map(|event| {
                format!(
                    "event: {}\ndata: {event}\n\n",
                    event["type"].as_str().unwrap()
                )
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unoffered_functions_invalid_arguments_and_unsupported_history() -> Result<()> {
        let mut request = json!({
            "model":"sonnet", "input":[{"role":"user","content":[{"type":"input_text","text":"Run a fixture."}]}],
            "tools":[{"type":"namespace","name":"functions","tools":[{"type":"function","name":"execute","parameters":{
                "type":"object","properties":{"cmd":{"type":"string"}},"required":["cmd"],"additionalProperties":false
            }}]}],
            "stream":true,
        });
        let input = Input::parse(&request)?;
        let result = |name: &str, arguments: &str| Reply {
            text: None,
            structured: cantrip_wire::Value::from_serialize(
                &json!({"type":"function","name":name,"arguments":arguments}),
            ),
            tokens: Some((10, 15, 5)),
        };
        assert!(input.reply(result("different", "{}")).is_err());
        assert!(
            input
                .reply(result("functions.execute", r#"{"cmd":2}"#))
                .is_err()
        );
        assert!(
            input
                .reply(result("functions.execute", r#"{"cmd":"echo","extra":2}"#))
                .is_err()
        );
        let output = input.reply(result("functions.execute", r#"{"cmd":"echo"}"#))?;
        assert_eq!(output.item["name"], "execute");
        assert_eq!(output.item["namespace"], "functions");
        assert_eq!(output.response["end_turn"], false);
        assert_eq!(output.response["usage"]["total_tokens"], 25);
        assert!(output.events().contains("response.output_item.done"));
        request["input"][0]["content"][0]["type"] = json!("input_image");
        assert!(Input::parse(&request).is_err());
        request["input"] = json!([{"type":"reasoning","encrypted_content":"opaque"}]);
        assert!(Input::parse(&request).is_err());
        Ok(())
    }
}
