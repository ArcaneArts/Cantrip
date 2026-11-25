//! Bounded inputs for the checkout-scoped read-only MCP tools.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

pub const MAX_PATH_BYTES: usize = 1024;
pub const MAX_QUERY_BYTES: usize = 512;
pub const MAX_LIST_ENTRIES: u16 = 100;
pub const MAX_GRAPH_RESULTS: u16 = 20;
pub const MAX_TEXT_BYTES: u16 = 8192;
pub const MAX_BYTE_OFFSET: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GraphQuery {
    Symbols,
    References,
    Context,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkout {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryList {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    #[serde(default)]
    pub path: String,
    #[serde(default = "list_limit")]
    pub limit: u16,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileMetadata {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRead {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    pub path: String,
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "text_limit")]
    pub max_bytes: u16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileSearch {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    #[serde(default)]
    pub path: String,
    pub query: String,
    #[serde(default = "list_limit")]
    pub limit: u16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeGraphQuery {
    pub project_id: Uuid,
    pub worktree_id: Option<String>,
    pub kind: GraphQuery,
    pub query: String,
    #[serde(default = "graph_limit")]
    pub limit: u16,
}

fn list_limit() -> u16 {
    25
}
fn text_limit() -> u16 {
    4096
}
fn graph_limit() -> u16 {
    10
}

pub fn worktree_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

pub fn relative_path(path: &str) -> bool {
    path.len() <= MAX_PATH_BYTES
        && !path.contains(['\\', '\0'])
        && (path.is_empty()
            || path.split('/').all(|component| {
                !matches!(component, "" | "." | "..")
                    && !component.eq_ignore_ascii_case(".git")
                    && !component.eq_ignore_ascii_case(".codegraph-cantrip")
                    && !component
                        .as_bytes()
                        .get(1)
                        .is_some_and(|byte| *byte == b':')
            }))
}

pub fn query(text: &str) -> bool {
    !text.trim().is_empty() && text.len() <= MAX_QUERY_BYTES && !text.contains('\0')
}

pub fn cursor(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(super) fn definition(tool: super::orchestration::Tool) -> Value {
    use super::orchestration::Tool::*;
    let id = json!({"type":"string","format":"uuid"});
    let path = |required| json!({"type":"string","minLength":if required {1} else {0}, "maxLength":MAX_PATH_BYTES});
    let limit = |maximum, default| json!({"type":"integer","minimum":1,"maximum":maximum,"default":default});
    let search = || json!({"type":"string","minLength":1,"maxLength":MAX_QUERY_BYTES});
    let integer = || json!({"type":"integer","minimum":0});
    let nullable_integer = || json!({"type":["integer","null"],"minimum":0});
    let nullable_string = || json!({"type":["string","null"]});
    let entry = || {
        json!({
            "type":"object",
            "properties":{
                "path":path(true),"name":{"type":"string"},
                "kind":{"enum":["directory","file","symlink","other"]},
                "size":nullable_integer(),"modifiedAt":nullable_string(),
            },
            "required":["path","name","kind","size","modifiedAt"],
        })
    };
    let symbol = json!({
        "type":"object",
        "properties":{
            "id":nullable_string(),"name":nullable_string(),"kind":nullable_string(),
            "path":path(true),"line":nullable_integer(),"endLine":nullable_integer(),
        },
        "required":["id","name","kind","path","line","endLine"],
    });
    let symbols = || json!({"type":"array","maxItems":MAX_GRAPH_RESULTS,"items":symbol});
    let mut input = Map::from_iter([
        ("projectId".to_owned(), id.clone()),
        (
            "worktreeId".to_owned(),
            json!({"type":"string","minLength":1,"maxLength":256}),
        ),
    ]);
    let mut required = vec!["projectId"];
    let (description, key, result) = match tool {
        DirectoryList => {
            input.insert("path".into(), path(false));
            input.insert("limit".into(), limit(MAX_LIST_ENTRIES, 25));
            input.insert(
                "cursor".into(),
                json!({"type":"string","pattern":"^[a-zA-Z0-9_-]{1,256}$"}),
            );
            (
                "List directory entries inside an authorized checkout. An empty path selects its root.",
                "entries",
                json!({"type":"array","maxItems":MAX_LIST_ENTRIES,"items":entry()}),
            )
        }
        FileMetadata => {
            input.insert("path".into(), path(true));
            required.push("path");
            (
                "Read the metadata of a checkout-relative file or directory.",
                "entry",
                entry(),
            )
        }
        FileRead => {
            input.insert("path".into(), path(true));
            input.insert(
                "offset".into(),
                json!({"type":"integer","minimum":0,"maximum":MAX_BYTE_OFFSET}),
            );
            input.insert(
                "maxBytes".into(),
                json!({"type":"integer","minimum":4,"maximum":MAX_TEXT_BYTES,"default":4096}),
            );
            required.push("path");
            (
                "Read UTF-8 text within the checkout. Pass nextOffset back to continue a large file.",
                "text",
                json!({"type":"string"}),
            )
        }
        FileSearch => {
            input.insert("path".into(), path(false));
            input.insert("query".into(), search());
            input.insert("limit".into(), limit(MAX_LIST_ENTRIES, 25));
            required.push("query");
            (
                "Find paths by filename within the selected checkout or directory.",
                "entries",
                json!({"type":"array","maxItems":MAX_LIST_ENTRIES,"items":{
                    "type":"object","properties":{"path":path(true)},"required":["path"],
                }}),
            )
        }
        CodegraphStatus => (
            "Check whether the selected checkout's CodeGraph index is available or stale.",
            "state",
            json!({"enum":["ready","stale","missing","unavailable"]}),
        ),
        CodegraphQuery => {
            input.insert(
                "kind".into(),
                json!({"enum":["symbols","references","context"]}),
            );
            input.insert("query".into(), search());
            input.insert("limit".into(), limit(MAX_GRAPH_RESULTS, 10));
            required.extend(["kind", "query"]);
            (
                "Search symbols, references, or related code using the checkout's existing CodeGraph index.",
                "result",
                json!({"anyOf":[symbols(),{
                    "type":"object",
                    "properties":{
                        "symbols":symbols(),
                        "relationships":{"type":"array","maxItems":60,"items":{
                            "type":"object","properties":{
                                "source":{"type":"string"},"target":{"type":"string"},
                                "kind":nullable_string(),"line":nullable_integer(),
                            },"required":["source","target","kind","line"],
                        }},
                    },"required":["symbols","relationships"],
                }]}),
            )
        }
        _ => unreachable!("Inspection tool"),
    };
    let mut output = Map::from_iter([
        ("summary".to_owned(), json!({"type":"string"})),
        ("projectId".to_owned(), id),
        ("worktreeId".to_owned(), json!({"type":"string"})),
        (key.to_owned(), result),
    ]);
    let fields = match tool {
        DirectoryList => vec![
            ("path", path(false)),
            ("nextCursor", nullable_string()),
            ("truncated", json!({"type":"boolean"})),
        ],
        FileRead => vec![
            ("path", path(true)),
            ("size", integer()),
            ("offset", integer()),
            ("nextOffset", nullable_integer()),
        ],
        FileSearch => vec![
            ("path", path(false)),
            ("truncated", json!({"type":"boolean"})),
        ],
        CodegraphQuery => vec![("kind", json!({"enum":["symbols","references","context"]}))],
        _ => Vec::new(),
    };
    let mut output_required = vec!["summary", "projectId", "worktreeId", key];
    for (name, schema) in fields {
        output.insert(name.to_owned(), schema);
        output_required.push(name);
    }
    json!({
        "name":tool,"description":description,
        "inputSchema":{"type":"object","additionalProperties":false,"properties":input,"required":required},
        "outputSchema":{"type":"object","properties":output,"required":output_required},
        "annotations":{"readOnlyHint":true,"idempotentHint":true,"openWorldHint":false},
    })
}
