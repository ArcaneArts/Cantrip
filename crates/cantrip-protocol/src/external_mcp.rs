//! Contracts for the external MCP discovery profile and its control-plane calls.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub mod execution;
pub mod inspection;
pub mod orchestration;

pub const PATH: &str = "/api/external-mcp/discovery";
pub const HOSTED_DISCOVERY_PATH: &str = "/api/external-mcp/hosted/discovery";
pub const HOSTED_CAPABILITIES_PATH: &str = "/api/external-mcp/hosted/capabilities";
pub const HOSTED_RELAY_PATH: &str = "/api/external-mcp/hosted/relay";
pub const LOCAL_RELAY_PATH: &str = "/api/external-mcp/relay";
pub const LOCAL_LEASE_ACCOUNT: &str = "external-mcp:local";
pub const OAUTH_SCOPE: &str = "mcp";
pub const OAUTH_AUTHORIZE_PATH: &str = "/api/external-mcp/oauth/authorize";
pub const OAUTH_TOKEN_PATH: &str = "/api/external-mcp/oauth/token";
pub const OAUTH_REGISTER_PATH: &str = "/api/external-mcp/oauth/register";
pub const OAUTH_EXCHANGE_PATH: &str = "/api/external-mcp/oauth/exchange";
pub const OAUTH_RESOURCE_PATH: &str = "/.well-known/oauth-protected-resource/mcp";
pub const OAUTH_METADATA_PATH: &str = "/.well-known/oauth-authorization-server";

pub fn opaque_secret(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|secret| {
        secret.len() == 43
            && secret
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}

pub const RELAY_READY: &str = "cantrip-external-mcp-relay-ready";
pub const WORKER_CONTEXT_TOOL: &str = "worker_context";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerContextInput {
    pub project_id: String,
}

impl WorkerContextInput {
    pub fn validate(&self) -> Result<(), &'static str> {
        uuid::Uuid::parse_str(&self.project_id)
            .map(|_| ())
            .map_err(|_| "Enter a Cantrip project ID.")
    }
}

pub fn parse_worker_context(input: &str) -> serde_json::Result<WorkerContextInput> {
    serde_json::from_str(input)
}

pub fn worker_context_tool() -> Value {
    json!({
        "name": WORKER_CONTEXT_TOOL,
        "description": "Ask the live worker assigned to a project for its execution context.",
        "inputSchema": {
            "type":"object",
            "additionalProperties":false,
            "required":["projectId"],
            "properties":{"projectId":{"type":"string","format":"uuid"}},
        },
        "annotations":{"readOnlyHint":true},
    })
}
pub const MAX_REQUEST_BYTES: usize = 8 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 512 * 1024;
pub const MODERN_VERSION: &str = "2026-07-28";
pub const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
pub const MAX_GRANT_SECONDS: u32 = 365 * 24 * 60 * 60;
pub const INTEGRATION_CREDENTIAL_PREFIX: &str = "ctmcp_";

pub fn valid_integration_credential(credential: &str) -> bool {
    opaque_secret(credential, INTEGRATION_CREDENTIAL_PREFIX)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntegrationScope {
    ProjectsRead,
    ChatsRead,
    ChatsWrite,
    TasksRead,
    TasksWrite,
    PlacementsRead,
    FilesRead,
    CommandsExecute,
    CliRead,
    CliRunsWrite,
    #[serde(rename = "codegraph-read")]
    CodeGraphRead,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum ProjectAccess {
    All,
    Selected {
        #[serde(rename = "projectIds")]
        project_ids: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationPermissions {
    pub projects: ProjectAccess,
    pub scopes: Vec<IntegrationScope>,
}

impl IntegrationPermissions {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.scopes.is_empty()
            || self
                .scopes
                .iter()
                .enumerate()
                .any(|(index, scope)| self.scopes[..index].contains(scope))
        {
            return Err("Choose one or more distinct integration scopes.");
        }
        if let ProjectAccess::Selected { project_ids } = &self.projects
            && (project_ids.is_empty()
                || project_ids.len() > 100
                || project_ids.iter().enumerate().any(|(index, id)| {
                    uuid::Uuid::parse_str(id).is_err() || project_ids[..index].contains(id)
                }))
        {
            return Err("Choose between 1 and 100 distinct projects.");
        }
        Ok(())
    }

    pub fn permits_project(&self, project_id: &str) -> bool {
        match &self.projects {
            ProjectAccess::All => true,
            ProjectAccess::Selected { project_ids } => {
                project_ids.iter().any(|id| id == project_id)
            }
        }
    }

    pub fn permits_tool(&self, tool: DiscoveryTool) -> bool {
        self.permits_scope(tool.integration_scope())
    }

    pub fn permits_scope(&self, scope: IntegrationScope) -> bool {
        self.scopes.contains(&scope)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationCreate {
    pub label: String,
    pub permissions: IntegrationPermissions,
    pub expires_in_seconds: u32,
}

impl IntegrationCreate {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.label.trim().is_empty()
            || self.label.encode_utf16().count() > 100
            || self.label.chars().any(char::is_control)
        {
            return Err("Enter an integration name of up to 100 characters.");
        }
        if !(1..=MAX_GRANT_SECONDS).contains(&self.expires_in_seconds) {
            return Err("Set an expiry between one second and one year.");
        }
        self.permissions.validate()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationRotate {
    pub expires_in_seconds: u32,
}

impl IntegrationRotate {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(1..=MAX_GRANT_SECONDS).contains(&self.expires_in_seconds) {
            return Err("Set an expiry between one second and one year.");
        }
        Ok(())
    }
}

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

    pub fn integration_scope(self) -> IntegrationScope {
        match self {
            Self::WorkspaceList | Self::ProjectList => IntegrationScope::ProjectsRead,
            Self::ChatList | Self::AgentList => IntegrationScope::ChatsRead,
            Self::TaskList => IntegrationScope::TasksRead,
            Self::PlacementList | Self::WorkerList => IntegrationScope::PlacementsRead,
        }
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
    fn integration_scope_applies_to_projects_and_tool_families() {
        let project = "11111111-1111-4111-8111-111111111111";
        let permissions: IntegrationPermissions = serde_json::from_value(json!({
            "projects":{"kind":"selected","projectIds":[project]},
            "scopes":["projects-read","chats-read"],
        }))
        .unwrap();
        assert!(permissions.validate().is_ok());
        assert!(permissions.permits_project(project));
        assert!(!permissions.permits_project("22222222-2222-4222-8222-222222222222"));
        assert!(permissions.permits_tool(DiscoveryTool::ProjectList));
        assert!(permissions.permits_tool(DiscoveryTool::AgentList));
        assert!(!permissions.permits_tool(DiscoveryTool::TaskList));
        assert!(!permissions.permits_tool(DiscoveryTool::WorkerList));
    }

    #[test]
    fn integration_credentials_are_distinct_from_other_cantrip_credentials() {
        assert!(valid_integration_credential(&format!(
            "ctmcp_{}",
            "A".repeat(43)
        )));
        for credential in [
            "ctmcp_too-short".to_owned(),
            format!("ctwk_{}", "A".repeat(43)),
            format!("ctmcp_{}=", "A".repeat(42)),
        ] {
            assert!(!valid_integration_credential(&credential));
        }
    }

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
