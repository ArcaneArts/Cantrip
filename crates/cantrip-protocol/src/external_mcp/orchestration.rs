//! Inputs for the project orchestration tools carried over WorkerLink.
use super::{IntegrationScope, inspection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const MAX_WAIT_MS: u64 = 10_000;
pub const CORE_PATH: &str = "/api/internal/external-mcp";
const MAX_TEXT_BYTES: usize = 8 * 1024;
const MAX_TITLE_BYTES: usize = 200;
const MAX_MESSAGES: u16 = 25;
const MAX_TASKS: usize = 10;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    AgentCreate,
    AgentRead,
    ChatSend,
    ChatRead,
    ChatWait,
    TaskCreate,
    TaskStart,
    TaskStatus,
    TaskWait,
    DirectoryList,
    FileMetadata,
    FileRead,
    FileSearch,
    CodegraphStatus,
    CodegraphQuery,
}

impl Tool {
    pub const ALL: [Self; 15] = [
        Self::AgentCreate,
        Self::AgentRead,
        Self::ChatSend,
        Self::ChatRead,
        Self::ChatWait,
        Self::TaskCreate,
        Self::TaskStart,
        Self::TaskStatus,
        Self::TaskWait,
        Self::DirectoryList,
        Self::FileMetadata,
        Self::FileRead,
        Self::FileSearch,
        Self::CodegraphStatus,
        Self::CodegraphQuery,
    ];

    pub fn scope(self) -> IntegrationScope {
        match self {
            Self::AgentCreate | Self::ChatSend => IntegrationScope::ChatsWrite,
            Self::AgentRead | Self::ChatRead | Self::ChatWait => IntegrationScope::ChatsRead,
            Self::TaskCreate | Self::TaskStart => IntegrationScope::TasksWrite,
            Self::TaskStatus | Self::TaskWait => IntegrationScope::TasksRead,
            Self::DirectoryList | Self::FileMetadata | Self::FileRead | Self::FileSearch => {
                IntegrationScope::FilesRead
            }
            Self::CodegraphStatus | Self::CodegraphQuery => IntegrationScope::CodeGraphRead,
        }
    }

    pub fn decode(value: &str) -> serde_json::Result<Self> {
        serde_json::from_str(value)
    }

    pub fn requires_chat(self) -> bool {
        matches!(
            self,
            Self::AgentRead | Self::ChatSend | Self::ChatRead | Self::ChatWait | Self::TaskStart
        )
    }

    pub fn uses_checkout(self) -> bool {
        matches!(
            self.scope(),
            IntegrationScope::FilesRead | IntegrationScope::CodeGraphRead
        )
    }

    pub fn definition(self) -> Value {
        if self.uses_checkout() {
            return inspection::definition(self);
        }
        let id = || json!({"type":"string","format":"uuid"});
        let bounded_text = |max| json!({"type":"string","minLength":1,"maxLength":max});
        let cursor = || json!({"type":"string","pattern":"^[a-f0-9]{64}$"});
        let timeout =
            || json!({"type":"integer","minimum":0,"maximum":MAX_WAIT_MS,"default":MAX_WAIT_MS});
        let mut fields = Map::from_iter([("projectId".to_owned(), id())]);
        let mut required = vec!["projectId"];
        if matches!(
            self,
            Self::AgentRead | Self::ChatSend | Self::ChatRead | Self::ChatWait
        ) {
            fields.insert("chatId".into(), id());
            required.push("chatId");
        }
        let mutation = matches!(
            self.scope(),
            IntegrationScope::ChatsWrite | IntegrationScope::TasksWrite
        );
        if mutation {
            fields.insert(
                "operationId".into(),
                json!({"type":"string","format":"uuid","description":"Use the same operation ID when retrying the same request."}),
            );
            required.push("operationId");
        }
        let description = match self {
            Self::AgentCreate => {
                fields.insert("title".into(), bounded_text(MAX_TITLE_BYTES));
                "Create an Agent chat in the project. Use chat_send with the returned chat ID."
            }
            Self::AgentRead => {
                "Inspect an Agent chat, its current placement and turn, and its native subagents."
            }
            Self::ChatSend => {
                fields.insert("message".into(), bounded_text(MAX_TEXT_BYTES));
                required.push("message");
                "Send work to a Cantrip Agent chat through its normal queue. Use chat_wait to follow the reply."
            }
            Self::ChatRead => {
                fields.insert(
                    "limit".into(),
                    json!({"type":"integer","minimum":1,"maximum":MAX_MESSAGES,"default":10}),
                );
                fields.insert(
                    "beforeSequence".into(),
                    json!({"type":"integer","minimum":1,"maximum":9007199254740991_u64}),
                );
                "Read a bounded page of an Agent chat transcript and get a cursor for chat_wait."
            }
            Self::ChatWait => {
                fields.insert("afterCursor".into(), cursor());
                fields.insert("timeoutMs".into(), timeout());
                required.push("afterCursor");
                "Wait for the Agent chat to change. On timeout, pass its cursor to another wait."
            }
            Self::TaskCreate => {
                fields.insert("title".into(), bounded_text(MAX_TITLE_BYTES));
                fields.insert("description".into(), bounded_text(MAX_TEXT_BYTES));
                fields.insert("start".into(), json!({"type":"boolean","default":true}));
                required.push("description");
                "Create a project Task. It queues for direct execution by default. Set start to false to leave a draft."
            }
            Self::TaskStart => {
                fields.insert("taskId".into(), id());
                required.push("taskId");
                "Queue a draft Task using the project's normal scheduler. Use task_wait to monitor the result."
            }
            Self::TaskStatus | Self::TaskWait => {
                fields.insert("taskIds".into(), json!({"type":"array","minItems":1,"maxItems":MAX_TASKS,"uniqueItems":true,"items":id()}));
                required.push("taskIds");
                if self == Self::TaskWait {
                    fields.insert("afterCursor".into(), cursor());
                    fields.insert("timeoutMs".into(), timeout());
                    fields.insert(
                        "mode".into(),
                        json!({"type":"string","enum":["any","all"],"default":"all"}),
                    );
                    "Wait for Task state to change or for the requested Tasks to finish. A scheduled retry remains active."
                } else {
                    "Read Task status and get a cursor for task_wait."
                }
            }
            _ => unreachable!("Inspection tools have separate schemas"),
        };
        json!({
            "name":self,"description":description,
            "inputSchema":{"type":"object","additionalProperties":false,"properties":fields,"required":required},
            "outputSchema":self.output_schema(),
            "annotations":{"readOnlyHint":!mutation,"idempotentHint":true,"openWorldHint":false},
        })
    }

    fn output_schema(self) -> Value {
        let id = || json!({"type":"string","format":"uuid"});
        let string = || json!({"type":"string"});
        let object = || json!({"type":"object"});
        let records = || json!({"type":"array","items":object()});
        let mut fields = Map::from_iter([
            ("summary".to_owned(), string()),
            ("projectId".to_owned(), id()),
        ]);
        let details: Vec<(&str, Value)> = match self {
            Self::AgentCreate => vec![
                ("operationId", id()),
                ("chatId", id()),
                ("state", json!({"const":"created"})),
            ],
            Self::AgentRead | Self::ChatRead | Self::ChatWait => vec![
                ("agent", object()),
                ("messages", records()),
                ("subagents", records()),
                ("page", object()),
                ("cursor", string()),
            ],
            Self::ChatSend => vec![
                ("operationId", id()),
                ("chatId", id()),
                ("messageId", id()),
                ("promptId", id()),
                (
                    "delivery",
                    json!({"enum":["queued","running","paused","blocked","failed"]}),
                ),
                (
                    "actor",
                    json!({"type":"object","required":["kind","id","label"],"properties":{
                        "kind":{"const":"external-integration"},"id":string(),"label":string()
                    }}),
                ),
            ],
            Self::TaskCreate | Self::TaskStart => {
                vec![("operationId", id()), ("taskId", id()), ("task", object())]
            }
            Self::TaskStatus | Self::TaskWait => vec![
                ("tasks", records()),
                ("missingTaskIds", json!({"type":"array","items":id()})),
                ("cursor", string()),
            ],
            _ => unreachable!("Inspection tools have separate result schemas"),
        };
        fields.extend(
            details
                .into_iter()
                .map(|(name, schema)| (name.to_owned(), schema)),
        );
        let required: Vec<_> = fields.keys().cloned().collect();
        json!({"type":"object","properties":fields,"required":required})
    }
}

/// The authorization request contains only routing information. The call
/// payload is carried separately inside the encrypted WorkerLink record.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selector {
    pub project_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<Tool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
}

impl Selector {
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("Serializable WorkerLink selector")
    }

    pub fn is_valid(&self) -> bool {
        self.tool.is_some_and(Tool::requires_chat) == self.chat_id.is_some()
            && self.worktree_id.as_deref().is_none_or(|worktree| {
                self.tool.is_some_and(Tool::uses_checkout) && inspection::worktree_id(worktree)
            })
    }

    pub fn scope(&self) -> IntegrationScope {
        self.tool
            .map_or(IntegrationScope::PlacementsRead, Tool::scope)
    }
}

/// Only a worker holding the live WorkerLink grant can send a Core call.
/// Preparation and transcript reads carry the existing opaque Cantrip wire
/// records, and tool arguments remain at the trusted worker.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreCall {
    pub worker_generation: String,
    pub operation: CoreOperation,
}

impl CoreCall {
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("Serializable Core operation")
    }
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CoreOperation {
    Checkout,
    Chat {
        limit: u16,
        before_sequence: Option<u64>,
    },
    Tasks {
        task_ids: Vec<Uuid>,
    },
    Prepare {
        operation_id: Uuid,
    },
    Commit {
        operation_id: Uuid,
        key_revision: i32,
        fingerprint: String,
        protected_request: Value,
    },
}

impl CoreOperation {
    pub fn commit(
        operation_id: Uuid,
        key_revision: i32,
        fingerprint: String,
        protected_request: &str,
    ) -> serde_json::Result<Self> {
        Ok(Self::Commit {
            operation_id,
            key_revision,
            fingerprint,
            protected_request: serde_json::from_str(protected_request)?,
        })
    }
}

/// Stable UUID for a resource created by an external operation. The kind keeps
/// a chat, message, and queue entry in distinct UUID domains.
pub fn resource_id(owner: &str, principal: &str, operation: Uuid, kind: &str) -> Uuid {
    let input = json!([
        "cantrip-external-mcp-resource-v1",
        owner,
        principal,
        operation,
        kind
    ]);
    let digest = Sha256::digest(input.to_string());
    let mut bytes: [u8; 16] = digest[..16].try_into().expect("SHA-256 digest prefix");
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WaitMode {
    Any,
    #[default]
    All,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "tool",
    content = "arguments",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Call {
    AgentCreate {
        project_id: Uuid,
        operation_id: Uuid,
        title: Option<String>,
    },
    AgentRead {
        project_id: Uuid,
        chat_id: Uuid,
    },
    ChatSend {
        project_id: Uuid,
        chat_id: Uuid,
        operation_id: Uuid,
        message: String,
    },
    ChatRead {
        project_id: Uuid,
        chat_id: Uuid,
        #[serde(default = "message_limit")]
        limit: u16,
        before_sequence: Option<u64>,
    },
    ChatWait {
        project_id: Uuid,
        chat_id: Uuid,
        after_cursor: String,
        #[serde(default = "wait_ms")]
        timeout_ms: u64,
    },
    TaskCreate {
        project_id: Uuid,
        operation_id: Uuid,
        title: Option<String>,
        description: String,
        #[serde(default = "start_task")]
        start: bool,
    },
    TaskStart {
        project_id: Uuid,
        operation_id: Uuid,
        task_id: Uuid,
    },
    TaskStatus {
        project_id: Uuid,
        task_ids: Vec<Uuid>,
    },
    TaskWait {
        project_id: Uuid,
        task_ids: Vec<Uuid>,
        after_cursor: Option<String>,
        #[serde(default = "wait_ms")]
        timeout_ms: u64,
        #[serde(default)]
        mode: WaitMode,
    },
    DirectoryList(inspection::DirectoryList),
    FileMetadata(inspection::FileMetadata),
    FileRead(inspection::FileRead),
    FileSearch(inspection::FileSearch),
    CodegraphStatus(inspection::Checkout),
    CodegraphQuery(inspection::CodeGraphQuery),
}

fn message_limit() -> u16 {
    10
}

fn wait_ms() -> u64 {
    MAX_WAIT_MS
}

fn start_task() -> bool {
    true
}

impl Call {
    pub fn decode(input: &[u8]) -> serde_json::Result<Self> {
        serde_json::from_slice(input)
    }

    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("Serializable MCP operation")
    }

    pub fn tool(&self) -> Tool {
        match self {
            Self::AgentCreate { .. } => Tool::AgentCreate,
            Self::AgentRead { .. } => Tool::AgentRead,
            Self::ChatSend { .. } => Tool::ChatSend,
            Self::ChatRead { .. } => Tool::ChatRead,
            Self::ChatWait { .. } => Tool::ChatWait,
            Self::TaskCreate { .. } => Tool::TaskCreate,
            Self::TaskStart { .. } => Tool::TaskStart,
            Self::TaskStatus { .. } => Tool::TaskStatus,
            Self::TaskWait { .. } => Tool::TaskWait,
            Self::DirectoryList(_) => Tool::DirectoryList,
            Self::FileMetadata(_) => Tool::FileMetadata,
            Self::FileRead(_) => Tool::FileRead,
            Self::FileSearch(_) => Tool::FileSearch,
            Self::CodegraphStatus(_) => Tool::CodegraphStatus,
            Self::CodegraphQuery(_) => Tool::CodegraphQuery,
        }
    }

    pub fn project(&self) -> Uuid {
        match self {
            Self::AgentCreate { project_id, .. }
            | Self::AgentRead { project_id, .. }
            | Self::ChatSend { project_id, .. }
            | Self::ChatRead { project_id, .. }
            | Self::ChatWait { project_id, .. }
            | Self::TaskCreate { project_id, .. }
            | Self::TaskStart { project_id, .. }
            | Self::TaskStatus { project_id, .. }
            | Self::TaskWait { project_id, .. } => *project_id,
            Self::DirectoryList(input) => input.project_id,
            Self::FileMetadata(input) => input.project_id,
            Self::FileRead(input) => input.project_id,
            Self::FileSearch(input) => input.project_id,
            Self::CodegraphStatus(input) => input.project_id,
            Self::CodegraphQuery(input) => input.project_id,
        }
    }

    pub fn selector(&self) -> Selector {
        let chat_id = match self {
            Self::AgentRead { chat_id, .. }
            | Self::ChatSend { chat_id, .. }
            | Self::ChatRead { chat_id, .. }
            | Self::ChatWait { chat_id, .. } => Some(*chat_id),
            Self::TaskStart { task_id, .. } => Some(*task_id),
            _ => None,
        };
        Selector {
            project_id: self.project(),
            tool: Some(self.tool()),
            chat_id,
            worktree_id: match self {
                Self::DirectoryList(input) => input.worktree_id.clone(),
                Self::FileMetadata(input) => input.worktree_id.clone(),
                Self::FileRead(input) => input.worktree_id.clone(),
                Self::FileSearch(input) => input.worktree_id.clone(),
                Self::CodegraphStatus(input) => input.worktree_id.clone(),
                Self::CodegraphQuery(input) => input.worktree_id.clone(),
                _ => None,
            },
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        let valid_text = |text: &str, max| !text.trim().is_empty() && text.len() <= max;
        let valid_cursor = |cursor: &str| {
            cursor.len() == 64
                && cursor
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        let valid_task_ids = |ids: &[Uuid]| {
            (1..=MAX_TASKS).contains(&ids.len())
                && !ids
                    .iter()
                    .enumerate()
                    .any(|(index, id)| ids[..index].contains(id))
        };
        let valid = match self {
            Self::AgentCreate { title, .. } => title
                .as_deref()
                .is_none_or(|title| valid_text(title, MAX_TITLE_BYTES)),
            Self::AgentRead { .. } | Self::TaskStart { .. } => true,
            Self::ChatSend { message, .. } => valid_text(message, MAX_TEXT_BYTES),
            Self::ChatRead {
                limit,
                before_sequence,
                ..
            } => {
                (1..=MAX_MESSAGES).contains(limit)
                    && before_sequence
                        .is_none_or(|before| (1..=9_007_199_254_740_991).contains(&before))
            }
            Self::ChatWait {
                after_cursor,
                timeout_ms,
                ..
            } => valid_cursor(after_cursor) && *timeout_ms <= MAX_WAIT_MS,
            Self::TaskCreate {
                title, description, ..
            } => {
                title
                    .as_deref()
                    .is_none_or(|title| valid_text(title, MAX_TITLE_BYTES))
                    && valid_text(description, MAX_TEXT_BYTES)
            }
            Self::TaskStatus { task_ids, .. } => valid_task_ids(task_ids),
            Self::TaskWait {
                task_ids,
                after_cursor,
                timeout_ms,
                ..
            } => {
                valid_task_ids(task_ids)
                    && after_cursor.as_deref().is_none_or(valid_cursor)
                    && *timeout_ms <= MAX_WAIT_MS
            }
            Self::DirectoryList(input) => {
                inspection::relative_path(&input.path)
                    && (1..=inspection::MAX_LIST_ENTRIES).contains(&input.limit)
                    && input.cursor.as_deref().is_none_or(inspection::cursor)
            }
            Self::FileMetadata(input) => {
                !input.path.is_empty() && inspection::relative_path(&input.path)
            }
            Self::FileRead(input) => {
                !input.path.is_empty()
                    && inspection::relative_path(&input.path)
                    && input.offset <= inspection::MAX_BYTE_OFFSET
                    && (4..=inspection::MAX_TEXT_BYTES).contains(&input.max_bytes)
            }
            Self::FileSearch(input) => {
                inspection::relative_path(&input.path)
                    && inspection::query(&input.query)
                    && (1..=inspection::MAX_LIST_ENTRIES).contains(&input.limit)
            }
            Self::CodegraphStatus(_) => true,
            Self::CodegraphQuery(input) => {
                inspection::query(&input.query)
                    && (1..=inspection::MAX_GRAPH_RESULTS).contains(&input.limit)
            }
        };
        if valid && self.selector().is_valid() {
            Ok(())
        } else if self.tool().uses_checkout() {
            Err("Check the tool's checkout, relative path, cursor, or result limits.")
        } else {
            Err("Check the tool's text, cursor, timeout, or result limits.")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_match_strict_inputs() {
        let id = "94845ce6-c360-4549-bf11-dc5cb070538c";
        let cases = [
            (Tool::AgentCreate, json!({"operationId":id})),
            (Tool::AgentRead, json!({"chatId":id})),
            (
                Tool::ChatSend,
                json!({"chatId":id,"operationId":id,"message":"Summarize the changes."}),
            ),
            (Tool::ChatRead, json!({"chatId":id})),
            (
                Tool::ChatWait,
                json!({"chatId":id,"afterCursor":"a".repeat(64)}),
            ),
            (
                Tool::TaskCreate,
                json!({"operationId":id,"description":"Run the test suite."}),
            ),
            (Tool::TaskStart, json!({"operationId":id,"taskId":id})),
            (Tool::TaskStatus, json!({"taskIds":[id]})),
            (Tool::TaskWait, json!({"taskIds":[id]})),
            (Tool::DirectoryList, json!({})),
            (Tool::FileMetadata, json!({"path":"src/lib.rs"})),
            (
                Tool::FileRead,
                json!({"path":"src/lib.rs","offset":0,"maxBytes":32}),
            ),
            (Tool::FileSearch, json!({"query":"lib.rs"})),
            (Tool::CodegraphStatus, json!({"worktreeId":"secondary"})),
            (
                Tool::CodegraphQuery,
                json!({"kind":"symbols","query":"example"}),
            ),
        ];
        assert_eq!(cases.len(), Tool::ALL.len());
        for (tool, mut arguments) in cases {
            arguments["projectId"] = json!(id);
            let mut input = json!({"tool":tool,"arguments":arguments});
            let call: Call = serde_json::from_value(input.clone()).unwrap();
            assert!(call.validate().is_ok());
            assert_eq!(call.tool(), tool);
            assert_eq!(call.project().to_string(), id);
            let schema = tool.definition();
            for field in schema["inputSchema"]["required"].as_array().unwrap() {
                assert!(input["arguments"].get(field.as_str().unwrap()).is_some());
            }
            input["arguments"]["unexpected"] = json!(true);
            assert!(serde_json::from_value::<Call>(input).is_err());
        }
    }
}
