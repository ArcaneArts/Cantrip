//! Bounds and command vocabulary for external worker execution.
use super::{inspection, orchestration::Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

mod receipts;
pub use receipts::{CommandIdentity, CommandReceipt, CommandSnapshot, CommandState};

pub const MAX_EXECUTION_MS: u64 = 120_000;
pub const MAX_OUTPUT_BYTES: u16 = 8192;
pub const MAX_WAIT_MS: u64 = 10_000;
pub const MAX_COMMAND_ARGUMENTS: usize = 48;
pub const MAX_ARGUMENT_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionPolicy {
    #[default]
    Disabled,
    ReadOnly,
    WorkspaceWrite,
}

impl ExecutionPolicy {
    pub fn decode(input: &str) -> serde_json::Result<Self> {
        serde_json::from_str(input)
    }

    pub fn sandbox_access(self) -> Option<&'static str> {
        match self {
            Self::Disabled => None,
            Self::ReadOnly => Some("read"),
            Self::WorkspaceWrite => Some("write"),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandStart {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    pub operation_id: Uuid,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default = "execution_timeout")]
    pub timeout_ms: u64,
}

impl CommandStart {
    pub fn encode(&self) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec(self)
    }

    pub fn valid(&self) -> bool {
        let executable = &self.executable;
        !executable.is_empty()
            && executable.len() <= 512
            && !executable.chars().any(char::is_control)
            && inspection::relative_path(&self.cwd)
            && self.args.len() <= MAX_COMMAND_ARGUMENTS
            && self.args.iter().all(|arg| !arg.contains('\0'))
            && self.args.iter().map(String::len).sum::<usize>() <= MAX_ARGUMENT_BYTES
            && (1..=MAX_EXECUTION_MS).contains(&self.timeout_ms)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandId {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    pub command_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandOutput {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    pub command_id: Uuid,
    pub offset: Option<u64>,
    #[serde(default = "output_limit")]
    pub max_bytes: u16,
}

impl CommandOutput {
    pub fn valid(&self) -> bool {
        self.offset
            .is_none_or(|offset| offset <= inspection::MAX_BYTE_OFFSET)
            && (4..=MAX_OUTPUT_BYTES).contains(&self.max_bytes)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandWait {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    pub command_id: Uuid,
    pub after_revision: Option<u64>,
    #[serde(default = "wait_timeout")]
    pub timeout_ms: u64,
}

impl CommandWait {
    pub fn valid(&self) -> bool {
        self.after_revision
            .is_none_or(|revision| revision <= inspection::MAX_BYTE_OFFSET)
            && self.timeout_ms <= MAX_WAIT_MS
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliRead {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    pub command: CliCommand,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "name",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CliCommand {
    Context,
    TargetList,
    TargetShow,
    WorktreeList,
    WorktreeStatus,
    RunList,
    RunShow {
        configuration_id: Uuid,
    },
    RunStatus {
        configuration_id: Option<Uuid>,
    },
    RunLogs {
        configuration_id: Uuid,
        tail: Option<u16>,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunAction {
    Start,
    Restart,
    Stop,
}

impl RunAction {
    pub fn command(self) -> &'static str {
        match self {
            Self::Start => "run.start",
            Self::Restart => "run.restart",
            Self::Stop => "run.stop",
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CliRun {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    pub operation_id: Uuid,
    pub action: RunAction,
    pub configuration_id: Uuid,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CliInvocation {
    Read {
        command: CliCommand,
    },
    Run {
        action: RunAction,
        configuration_id: Uuid,
    },
}

fn execution_timeout() -> u64 {
    30_000
}
fn output_limit() -> u16 {
    4096
}
fn wait_timeout() -> u64 {
    MAX_WAIT_MS
}

pub(super) fn definition(tool: Tool) -> Value {
    use Tool::*;
    let id = || json!({"type":"string","format":"uuid"});
    let integer =
        |min, max, default| json!({"type":"integer","minimum":min,"maximum":max,"default":default});
    let mut fields = Map::from_iter([
        ("projectId".to_owned(), id()),
        (
            "worktreeId".to_owned(),
            json!({"type":"string","minLength":1,"maxLength":256}),
        ),
    ]);
    let mut required = vec!["projectId"];
    let (description, read_only) = match tool {
        CommandStart => {
            fields.extend([
                ("operationId".to_owned(), id()),
                ("executable".to_owned(), json!({"type":"string","minLength":1,"maxLength":512})),
                ("args".to_owned(), json!({"type":"array","maxItems":MAX_COMMAND_ARGUMENTS,"items":{"type":"string"}})),
                ("cwd".to_owned(), json!({"type":"string","description":"Checkout-relative directory. An empty value uses the checkout root."})),
                ("timeoutMs".to_owned(), integer(1, MAX_EXECUTION_MS, execution_timeout())),
            ]);
            required.extend(["operationId", "executable"]);
            (
                "Start a supervised command in a permitted checkout. Supply the executable and arguments separately. Reuse the operation ID only for an identical retry.",
                false,
            )
        }
        CommandStatus | CommandOutput | CommandWait | CommandCancel => {
            fields.insert("commandId".to_owned(), id());
            required.push("commandId");
            match tool {
                CommandOutput => {
                    fields.extend([
                        ("offset".to_owned(), json!({"type":"integer","minimum":0,"maximum":inspection::MAX_BYTE_OFFSET})),
                        ("maxBytes".to_owned(), integer(4, MAX_OUTPUT_BYTES.into(), output_limit().into())),
                    ]);
                    (
                        "Read bounded UTF-8 output. Pass nextOffset back to continue.",
                        true,
                    )
                }
                CommandWait => {
                    fields.extend([
                        ("afterRevision".to_owned(), json!({"type":"integer","minimum":0,"maximum":inspection::MAX_BYTE_OFFSET})),
                        ("timeoutMs".to_owned(), integer(0, MAX_WAIT_MS, wait_timeout())),
                    ]);
                    (
                        "Wait for command completion or a change after the given revision.",
                        true,
                    )
                }
                CommandCancel => ("Stop the supervised command and its process tree.", false),
                _ => (
                    "Read the command state, exit status, and output range.",
                    true,
                ),
            }
        }
        CantripCli => {
            let command = |name, extra: Map<String, Value>, mut keys: Vec<&str>| {
                let mut properties = extra;
                properties.insert("name".to_owned(), json!({"const":name}));
                keys.insert(0, "name");
                json!({"type":"object","properties":properties,"required":keys,"additionalProperties":false})
            };
            let by_id = || Map::from_iter([("configurationId".to_owned(), id())]);
            let mut variants = [
                "context",
                "target_list",
                "target_show",
                "worktree_list",
                "worktree_status",
                "run_list",
            ]
            .map(|name| command(name, Map::new(), vec![]))
            .to_vec();
            variants.extend([
                command("run_show", by_id(), vec!["configurationId"]),
                command("run_status", by_id(), vec![]),
                command(
                    "run_logs",
                    Map::from_iter([
                        ("configurationId".to_owned(), id()),
                        ("tail".to_owned(), integer(1, 100, 20)),
                    ]),
                    vec!["configurationId"],
                ),
            ]);
            fields.insert("command".to_owned(), json!({"oneOf":variants}));
            required.push("command");
            (
                "Invoke a typed Cantrip CLI read command for the authorized checkout and return its JSON result.",
                true,
            )
        }
        CantripCliRun => {
            fields.extend([
                ("operationId".to_owned(), id()),
                ("configurationId".to_owned(), id()),
                (
                    "action".to_owned(),
                    json!({"enum":["start","restart","stop"]}),
                ),
            ]);
            required.extend(["operationId", "configurationId", "action"]);
            (
                "Start, restart, or stop an existing Cantrip Run configuration with permission to manage Run lifecycle.",
                false,
            )
        }
        _ => unreachable!("Execution tool"),
    };
    let mut output = Map::from_iter([
        ("summary".to_owned(), json!({"type":"string"})),
        ("projectId".to_owned(), id()),
        ("worktreeId".to_owned(), json!({"type":"string"})),
    ]);
    let mut output_required = vec!["summary", "projectId", "worktreeId"];
    let fields_for_output = match tool {
        CantripCli | CantripCliRun => vec![("data", json!({}))],
        _ => {
            let mut command_fields = vec![
                ("commandId", id()),
                (
                    "state",
                    json!({"enum":["starting","running","cancelling","exited","cancelled","timed-out","interrupted","failed"]}),
                ),
                ("terminal", json!({"type":"boolean"})),
                ("revision", json!({"type":"integer","minimum":1})),
                ("exitCode", json!({"type":["integer","null"]})),
                ("signal", json!({"type":["string","null"]})),
                ("outputStart", json!({"type":"integer","minimum":0})),
                ("outputEnd", json!({"type":"integer","minimum":0})),
                ("outputTruncated", json!({"type":"boolean"})),
            ];
            match tool {
                CommandOutput => command_fields.extend([
                    ("text", json!({"type":"string"})),
                    ("offset", json!({"type":"integer","minimum":0})),
                    ("nextOffset", json!({"type":"integer","minimum":0})),
                ]),
                CommandWait => command_fields.push(("timedOut", json!({"type":"boolean"}))),
                CommandStart => command_fields.push(("operationId", id())),
                _ => {}
            }
            command_fields
        }
    };
    for (name, schema) in fields_for_output {
        output.insert(name.to_owned(), schema);
        output_required.push(name);
    }
    json!({
        "name":tool,"description":description,
        "inputSchema":{"type":"object","properties":fields,"required":required,"additionalProperties":false},
        "outputSchema":{"type":"object","properties":output,"required":output_required},
        "annotations":{"readOnlyHint":read_only,"idempotentHint":true,"openWorldHint":!read_only},
    })
}
