//! Contracts for the external MCP discovery profile and its control-plane calls.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PATH: &str = "/api/external-mcp/discovery";
pub const MAX_REQUEST_BYTES: usize = 8 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 512 * 1024;
pub const MODERN_VERSION: &str = "2026-07-28";
pub const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];

/// Validate the request authority on a listener bound to 127.0.0.1.
pub fn loopback_authority(host: &str, origin: Option<&str>, port: u16) -> bool {
    let host = host.to_ascii_lowercase();
    let allowed = ["127.0.0.1", "localhost"]
        .iter()
        .any(|ip| host == format!("{ip}:{port}") || (port == 80 && host == *ip));
    allowed && origin.is_none_or(|origin| origin.eq_ignore_ascii_case(&format!("http://{host}")))
}

pub fn proxy_header(name: &str) -> bool {
    name == "forwarded" || name.starts_with("x-forwarded-") || name == "via"
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscoveryTool {
    WorkspaceList,
    ProjectList,
    ChatList,
    AgentList,
    TaskList,
    PlacementList,
    WorkerList,
}

impl DiscoveryTool {
    pub const ALL: [Self; 7] = [
        Self::WorkspaceList,
        Self::ProjectList,
        Self::ChatList,
        Self::AgentList,
        Self::TaskList,
        Self::PlacementList,
        Self::WorkerList,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::WorkspaceList => "workspace_list",
            Self::ProjectList => "project_list",
            Self::ChatList => "chat_list",
            Self::AgentList => "agent_list",
            Self::TaskList => "task_list",
            Self::PlacementList => "placement_list",
            Self::WorkerList => "worker_list",
        }
    }

    pub fn project_scoped(self) -> bool {
        matches!(
            self,
            Self::ChatList | Self::AgentList | Self::TaskList | Self::PlacementList
        )
    }

    pub fn definition(self) -> Value {
        let description = match self {
            Self::WorkspaceList => "List workspaces the integration can discover.",
            Self::ProjectList => {
                "Find a Cantrip project and its stable ID before delegating to an agent."
            }
            Self::ChatList => "List the project's chats and their current state.",
            Self::AgentList => "Find an existing agent chat in a project.",
            Self::TaskList => "List the project's tasks and their scheduling state.",
            Self::PlacementList => {
                "List a project's worker placements and worktrees, including availability."
            }
            Self::WorkerList => {
                "List enrolled workers and their current availability and runtime status."
            }
        };
        let mut schema = json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "cursor": {"type":"string","minLength":1,"maxLength":2048},
                "limit": {"type":"integer","minimum":1,"maximum":100,"default":25},
            },
        });
        if self.project_scoped() {
            schema["properties"]["projectId"] =
                json!({"type":"string","minLength":1,"maxLength":256});
            schema["required"] = json!(["projectId"]);
        }
        json!({
            "name": self.name(),
            "description": description,
            "inputSchema": schema,
            "outputSchema": {
                "type":"object",
                "required":["summary","entries","nextCursor","sourceTruncated"],
                "properties":{
                    "summary":{"type":"string"},
                    "entries":{"type":"array","maxItems":100,"items":{
                        "type":"object","required":["id"],"properties":{"id":{"type":"string"}}
                    }},
                    "nextCursor":{"type":["string","null"]},
                    "sourceTruncated":{"type":"boolean"},
                }
            },
            "annotations": {"readOnlyHint":true,"destructiveHint":false,"openWorldHint":false},
        })
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryRequest {
    pub tool: DiscoveryTool,
    pub arguments: DiscoveryArguments,
}

impl DiscoveryRequest {
    pub fn decode(input: &str) -> serde_json::Result<Self> {
        serde_json::from_str(input)
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("string and number discovery fields")
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        let args = &self.arguments;
        if self.tool.project_scoped() != args.project_id.is_some() {
            return Err("Project tools require projectId. Account tools take no projectId.");
        }
        if args.project_id.as_ref().is_some_and(|id| {
            id.trim().is_empty() || id.len() > 256 || id.chars().any(char::is_control)
        }) {
            return Err("Invalid projectId.");
        }
        if !(1..=100).contains(&args.limit) {
            return Err("limit must be between 1 and 100.");
        }
        if args.cursor.as_ref().is_some_and(|cursor| {
            cursor.is_empty()
                || cursor.len() > 2048
                || !cursor
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        }) {
            return Err("Invalid page cursor.");
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryArguments {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: u16,
}

fn default_limit() -> u16 {
    25
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_authority_rejects_dns_rebinding_and_cross_origin_requests() {
        assert!(loopback_authority("127.0.0.1:1234", None, 1234));
        assert!(loopback_authority(
            "localhost:1234",
            Some("http://localhost:1234"),
            1234
        ));
        assert!(!loopback_authority("example.invalid:1234", None, 1234));
        assert!(!loopback_authority("localhost:4321", None, 1234));
        assert!(!loopback_authority(
            "127.0.0.1:1234",
            Some("http://localhost:1234"),
            1234
        ));
        assert!(!loopback_authority("localhost:1234", Some("null"), 1234));
    }

    #[test]
    fn discovery_definitions_and_requests_agree_on_scope_and_limits() {
        for tool in DiscoveryTool::ALL {
            let definition = tool.definition();
            assert_eq!(definition["name"], serde_json::to_value(tool).unwrap());
            let arguments = if tool.project_scoped() {
                json!({"projectId":"project-1"})
            } else {
                json!({})
            };
            let request: DiscoveryRequest =
                serde_json::from_value(json!({"tool":tool,"arguments":arguments})).unwrap();
            assert_eq!(request.arguments.limit, 25);
            assert!(request.validate().is_ok());
        }
        for (tool, arguments) in [
            (DiscoveryTool::TaskList, json!({})),
            (DiscoveryTool::WorkerList, json!({"projectId":"project-1"})),
            (DiscoveryTool::ProjectList, json!({"limit":101})),
            (DiscoveryTool::ProjectList, json!({"cursor":"invalid="})),
        ] {
            let request: DiscoveryRequest =
                serde_json::from_value(json!({"tool":tool,"arguments":arguments})).unwrap();
            assert!(request.validate().is_err());
        }
    }
}
