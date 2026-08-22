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

fn run_action_rows(data: Option<&Value>) -> Vec<Value> {
    data.and_then(|value| value.get("configurations"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|configuration| {
            let environment = configuration
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("-")
                .to_string();
            let revision = configuration
                .get("revision")
                .and_then(Value::as_str)
                .unwrap_or("-")
                .chars()
                .take(12)
                .collect::<String>();
            configuration
                .get("actions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(move |action| {
                    let mut action = action.clone();
                    let platform = action
                        .get("platform")
                        .cloned()
                        .filter(|value| !value.is_null())
                        .unwrap_or_else(|| Value::String("all".to_string()));
                    if let Some(object) = action.as_object_mut() {
                        object.insert(
                            "environment".to_string(),
                            Value::String(environment.clone()),
                        );
                        object.insert("revisionShort".to_string(), Value::String(revision.clone()));
                        object.insert("platformLabel".to_string(), platform);
                    }
                    action
                })
        })
        .collect()
}

fn run_diagnostics(data: Option<&Value>) -> Vec<Value> {
    let mut diagnostics = data
        .and_then(|value| value.get("diagnostics"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for configuration in data
        .and_then(|value| value.get("configurations"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        diagnostics.extend(
            configuration
                .get("diagnostics")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
    }
    diagnostics
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
            let rows = run_action_rows(result.data.as_ref());
            if !rows.is_empty() {
                print_rows(
                    &rows,
                    &[
                        ("ENVIRONMENT", "environment"),
                        ("ACTION", "name"),
                        ("PLATFORM", "platformLabel"),
                        ("SOURCE", "configurationPath"),
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
                if let Some(action) = data.get("action") {
                    println!("ID: {}", string(Some(action), "id"));
                    println!("Source: {}", string(Some(action), "configurationPath"));
                    println!("Platform: {}", string(Some(action), "platform"));
                    if let Some(command) = action.get("command").and_then(Value::as_str) {
                        println!("Command:\n{command}");
                    }
                }
                return;
            }
        }
        "run.validate" => {
            println!("{}", result.summary);
            let diagnostics = run_diagnostics(result.data.as_ref());
            if !diagnostics.is_empty() {
                print_rows(
                    &diagnostics,
                    &[
                        ("SEVERITY", "severity"),
                        ("CODE", "code"),
                        ("SOURCE", "configurationPath"),
                        ("MESSAGE", "message"),
                    ],
                );
            }
            return;
        }
        "run.config-path" => {
            println!("{}", result.summary);
            return;
        }
        "run.start" | "run.status" | "run.stop" => {
            println!("{}", result.summary);
            if let Some(run) = result.data.as_ref().and_then(|data| data.get("run")) {
                println!("ID: {}", string(Some(run), "id"));
                println!("State: {}", string(Some(run), "state"));
                println!("Action: {}", string(Some(run), "actionId"));
                println!("Worker: {}", string(Some(run), "workerId"));
                println!("Started: {}", string(Some(run), "startedAt"));
                println!("Ended: {}", string(Some(run), "endedAt"));
                println!("Exit code: {}", string(Some(run), "exitCode"));
                println!("Signal: {}", string(Some(run), "signal"));
            }
            return;
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

    use super::{policy_source_labels, run_action_rows, string};

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
    fn flattens_run_actions_with_environment_context() {
        let data = json!({
            "configurations": [{
                "name": "Spectral Lab",
                "revision": "0123456789abcdef",
                "actions": [{
                    "id": "action-id",
                    "name": "Run Spectral Lab",
                    "platform": "win32",
                    "configurationPath": ".codex/environments/environment.toml"
                }]
            }]
        });
        let rows = run_action_rows(Some(&data));
        assert_eq!(rows[0]["environment"], "Spectral Lab");
        assert_eq!(rows[0]["revisionShort"], "0123456789ab");
        assert_eq!(rows[0]["platformLabel"], "win32");
    }
}
