use serde_json::Value;

use crate::client::CommandResult;

fn string(value: Option<&Value>, key: &str) -> String {
    match value.and_then(|item| item.get(key)) {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => value.to_string(),
        _ => "-".to_string(),
    }
}

fn policy_source_labels(policy: &Value) -> String {
    policy
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|source| match source.get("type").and_then(Value::as_str) {
            Some("mandatory") => Some("mandatory".to_string()),
            Some("project") => Some("project".to_string()),
            Some("workspace") => Some(format!(
                "workspace:{}",
                source
                    .get("workspaceName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            )),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn print_rows(items: &[Value], columns: &[(&str, &str)]) {
    let widths = columns
        .iter()
        .map(|(heading, key)| {
            items
                .iter()
                .map(|item| string(Some(item), key).chars().count())
                .max()
                .unwrap_or(0)
                .max(heading.len())
                .min(42)
        })
        .collect::<Vec<_>>();
    for (index, (heading, _)) in columns.iter().enumerate() {
        print!(
            "{heading:<width$}{}",
            if index + 1 == columns.len() { "" } else { "  " },
            width = widths[index]
        );
    }
    println!();
    for item in items {
        for (index, (_, key)) in columns.iter().enumerate() {
            let mut value = string(Some(item), key);
            if value.chars().count() > widths[index] {
                value = format!(
                    "{}…",
                    value
                        .chars()
                        .take(widths[index].saturating_sub(1))
                        .collect::<String>()
                );
            }
            print!(
                "{value:<width$}{}",
                if index + 1 == columns.len() { "" } else { "  " },
                width = widths[index]
            );
        }
        println!();
    }
}

fn run_definition_rows(data: Option<&Value>) -> Vec<Value> {
    let runtimes = data
        .and_then(|value| value.get("runtimes"))
        .and_then(Value::as_array);
    data.and_then(|value| value.get("inventory"))
        .and_then(|value| value.get("entries"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|entry| {
            let mut row = entry.clone();
            let document = entry.get("document");
            let revision = entry
                .get("revision")
                .and_then(Value::as_str)
                .unwrap_or("-")
                .chars()
                .take(12)
                .collect::<String>();
            if let Some(object) = row.as_object_mut() {
                object.insert("revisionShort".to_string(), Value::String(revision));
                object.insert(
                    "name".to_string(),
                    document
                        .and_then(|value| value.get("name"))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                object.insert(
                    "provider".to_string(),
                    document
                        .and_then(|value| value.get("provider"))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                let runtime_state = entry
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(|id| {
                        runtimes.into_iter().flatten().find(|runtime| {
                            runtime.get("configurationId").and_then(Value::as_str) == Some(id)
                                && matches!(
                                    runtime.get("state").and_then(Value::as_str),
                                    Some("starting" | "running" | "restarting" | "stopping")
                                )
                        })
                    })
                    .and_then(|runtime| runtime.get("state"))
                    .cloned()
                    .unwrap_or_else(|| Value::String("idle".to_string()));
                object.insert("runtimeState".to_string(), runtime_state);
            }
            row
        })
        .collect()
}

pub fn render(command: &str, result: &CommandResult, json: bool) {
    if json {
        let value = serde_json::json!({
            "summary": result.summary,
            "target": result.target,
            "worktreeId": result.worktree_id,
            "continuationScheduled": result.continuation_scheduled,
            "mutated": result.mutated,
            "data": result.data,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&value).expect("serialize command result")
        );
        return;
    }

    match command {
        "policy.read" => {
            if let Some(content) = result
                .data
                .as_ref()
                .and_then(|value| value.get("policy"))
                .and_then(|value| value.get("bodyMarkdown"))
                .and_then(Value::as_str)
            {
                print!("{content}");
                if !content.ends_with('\n') {
                    println!();
                }
                return;
            }
        }
        "policy.list" => {
            if let Some(items) = result
                .data
                .as_ref()
                .and_then(|value| value.get("policies"))
                .and_then(Value::as_array)
            {
                let rows = items
                    .iter()
                    .map(|item| {
                        let mut item = item.clone();
                        let labels = policy_source_labels(&item);
                        if let Some(object) = item.as_object_mut() {
                            object.insert("sourceLabels".to_string(), Value::String(labels));
                        }
                        item
                    })
                    .collect::<Vec<_>>();
                print_rows(
                    &rows,
                    &[
                        ("KEY", "key"),
                        ("NAME", "name"),
                        ("SUMMARY", "summary"),
                        ("MANDATORY", "mandatory"),
                        ("SOURCES", "sourceLabels"),
                    ],
                );
                return;
            }
        }
        "explorer.read" => {
            if let Some(content) = result
                .data
                .as_ref()
                .and_then(|value| value.get("content"))
                .and_then(Value::as_str)
            {
                print!("{content}");
                if !content.ends_with('\n') {
                    println!();
                }
                return;
            }
        }
        "terminal.read" => {
            if let Some(content) = result
                .data
                .as_ref()
                .and_then(|value| value.get("data"))
                .and_then(Value::as_str)
            {
                print!("{content}");
                if !content.ends_with('\n') {
                    println!();
                }
                return;
            }
        }
        "worktree.list" => {
            if let Some(items) = result
                .data
                .as_ref()
                .and_then(|value| value.get("worktrees"))
                .and_then(Value::as_array)
            {
                print_rows(
                    items,
                    &[
                        ("NAME", "name"),
                        ("BRANCH", "branch"),
                        ("STATE", "lifecycleState"),
                        ("ID", "id"),
                    ],
                );
                return;
            }
        }
        "target.list" => {
            if let Some(items) = result
                .data
                .as_ref()
                .and_then(|value| value.get("targets"))
                .and_then(Value::as_array)
            {
                print_rows(
                    items,
                    &[
                        ("KIND", "resourceKind"),
                        ("NAME", "title"),
                        ("STATE", "availability"),
                    ],
                );
                return;
            }
        }
        "explorer.list" => {
            if let Some(items) = result
                .data
                .as_ref()
                .and_then(|value| value.get("entries"))
                .and_then(Value::as_array)
            {
                print_rows(
                    items,
                    &[("TYPE", "kind"), ("NAME", "name"), ("SIZE", "size")],
                );
                return;
            }
        }
        "run.list" => {
            let rows = run_definition_rows(result.data.as_ref());
            if !rows.is_empty() {
                print_rows(
                    &rows,
                    &[
                        ("NAME", "name"),
                        ("PROVIDER", "provider"),
                        ("RUNTIME", "runtimeState"),
                        ("DEFINITION", "status"),
                        ("REVISION", "revisionShort"),
                        ("ID", "id"),
                    ],
                );
                return;
            }
        }
        "run.show" => {
            if let Some(data) = &result.data {
                println!("{}", result.summary);
                if let Some(entry) = data.get("result").and_then(|value| value.get("entry")) {
                    println!("ID: {}", string(Some(entry), "id"));
                    println!("Source: {}", string(Some(entry), "relativePath"));
                    println!("Revision: {}", string(Some(entry), "revision"));
                    println!("State: {}", string(Some(entry), "status"));
                    if let Some(document) = entry.get("document") {
                        println!(
                            "{}",
                            serde_json::to_string_pretty(document)
                                .expect("serialize Run configuration")
                        );
                    }
                }
                return;
            }
        }
        "run.start" | "run.restart" | "run.stop" => {
            println!("{}", result.summary);
            if let Some(runtime) = result.data.as_ref().and_then(|data| data.get("runtime")) {
                println!("Runtime: {}", string(Some(runtime), "id"));
                println!(
                    "Configuration: {}",
                    string(Some(runtime), "configurationId")
                );
                println!("Worktree: {}", string(Some(runtime), "worktreeId"));
                println!("State: {}", string(Some(runtime), "state"));
                println!("Generation: {}", string(Some(runtime), "generation"));
            }
            return;
        }
        "run.status" => {
            if let Some(runtimes) = result
                .data
                .as_ref()
                .and_then(|data| data.get("runtimes"))
                .and_then(Value::as_array)
            {
                print_rows(
                    runtimes,
                    &[
                        ("CONFIGURATION", "configurationId"),
                        ("STATE", "state"),
                        ("GENERATION", "generation"),
                        ("WORKTREE", "worktreeId"),
                        ("RUNTIME", "id"),
                    ],
                );
                return;
            }
        }
        "run.logs" => {
            if let Some(data) = result
                .data
                .as_ref()
                .and_then(|data| data.get("data"))
                .and_then(Value::as_str)
            {
                print!("{data}");
                return;
            }
        }
        _ => {}
    }

    println!("{}", result.summary);
    if matches!(
        command,
        "status" | "target.show" | "worktree.status" | "browser.services"
    ) && let Some(data) = &result.data
    {
        println!(
            "{}",
            serde_json::to_string_pretty(data).expect("serialize command data")
        );
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{policy_source_labels, run_definition_rows, string};

    #[test]
    fn renders_policy_flags_and_source_labels() {
        let policy = json!({
            "mandatory": true,
            "sources": [
                { "type": "mandatory" },
                { "type": "workspace", "workspaceName": "Company" },
                { "type": "project", "projectId": "project-one" }
            ]
        });
        assert_eq!(string(Some(&policy), "mandatory"), "true");
        assert_eq!(
            policy_source_labels(&policy),
            "mandatory, workspace:Company, project"
        );
    }

    #[test]
    fn flattens_run_definitions_with_document_context() {
        let data = json!({
            "inventory": { "entries": [{
                "id": "spectral-lab",
                "status": "ready",
                "revision": "0123456789abcdef",
                "document": { "name": "Spectral Lab", "provider": "rust" }
            }] }
        });
        let rows = run_definition_rows(Some(&data));
        assert_eq!(rows[0]["name"], "Spectral Lab");
        assert_eq!(rows[0]["provider"], "rust");
        assert_eq!(rows[0]["revisionShort"], "0123456789ab");
    }
}
