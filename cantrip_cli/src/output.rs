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

    use super::{policy_source_labels, string};

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
}
