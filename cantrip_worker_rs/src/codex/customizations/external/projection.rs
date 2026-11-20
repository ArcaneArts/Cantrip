use super::super::{entries, nonempty};
use crate::{filesystem::paths, http::checked};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexMap;

pub(super) struct Candidate {
    pub preview: Value,
    item: Value,
}

fn item_type(value: &Value) -> Option<&JsString> {
    let name = nonempty(value)?;
    checked("codexExternalImportItemTypeSchema", value).ok()?;
    Some(name)
}

fn names(value: &Value, key: &str) -> Vec<JsString> {
    entries(value, key)
        .filter_map(|item| nonempty(&item["name"]).cloned())
        .collect()
}

fn details(value: &Value) -> Value {
    if !value.is_object() {
        return Value::Null;
    }
    let plugins: Vec<_> = entries(value, "plugins")
        .flat_map(|plugin| {
            let marketplace = nonempty(&plugin["marketplaceName"]);
            entries(plugin, "pluginNames").filter_map(move |name| {
                let name = name.as_js_string()?;
                Some(match marketplace {
                    Some(prefix) => {
                        JsString::new([prefix.units(), &[u16::from(b'/')], name.units()].concat())
                    }
                    None => name.clone(),
                })
            })
        })
        .collect();
    let memory: Vec<_> = entries(value, "memory")
        .filter_map(|file| {
            let file = paths::native(nonempty(file)?);
            Some(paths::text(file.file_name()?.as_ref()))
        })
        .collect();
    json!({
        "pluginNames":plugins,
        "skillNames":names(value, "skills"),
        "sessionCount":value["sessions"].as_array().map_or(0, |sessions| sessions.len()),
        "mcpServerNames":names(value, "mcpServers"),
        "hookNames":names(value, "hooks"),
        "subagentNames":names(value, "subagents"),
        "commandNames":names(value, "commands"),
        "memoryFiles":memory,
    })
}

pub(super) fn candidates(
    response: &Value,
    cwd: &JsString,
) -> Result<IndexMap<JsString, Candidate>> {
    let cwd = paths::resolve(&paths::native(cwd))?;
    let cwd_text = paths::text(&cwd);
    Ok(entries(response, "items")
        .enumerate()
        .filter_map(|(index, item)| {
            let kind = item_type(&item["itemType"])?;
            let source = paths::native(nonempty(&item["cwd"])?);
            if paths::resolve(&source).ok().as_ref() != Some(&cwd) {
                return None;
            }
            let description = item["description"]
                .as_js_string()
                .cloned()
                .unwrap_or_else(|| "".into());
            let digest = cantrip_history::source_digest(&json!({
                "itemType":kind,"cwd":cwd_text,"description":description,"index":index,
            }));
            let id = JsString::from(&digest[..24]);
            let preview = json!({
                "id":id,"itemType":kind,"description":description,"cwd":cwd_text,
                "details":details(&item["details"]),
            });
            Some((
                id,
                Candidate {
                    preview,
                    item: item.clone(),
                },
            ))
        })
        .collect())
}

pub(super) fn select(
    mut candidates: IndexMap<JsString, Candidate>,
    selected: &[&JsString],
) -> Result<Vec<Value>> {
    let selected = selected.iter()
        .map(|id| {
            candidates.swap_remove(*id)
                .context("One or more external configuration candidates changed; preview again before importing.")
        })
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        !selected
            .iter()
            .any(|candidate| candidate.preview["itemType"] == "PLUGINS"
                || candidate.item["details"]["plugins"]
                    .as_array()
                    .is_some_and(|plugins| !plugins.is_empty())),
        "Plugin imports are disabled while the official App Server plugin contract is unsuitable for production clients."
    );
    Ok(selected
        .into_iter()
        .map(|candidate| candidate.item)
        .collect())
}

fn clip(value: &Value, max: usize) -> Option<JsString> {
    let text = value.as_js_string()?;
    Some(JsString::new(text.units()[..text.len().min(max)].to_vec()))
}

fn failure(value: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let classes = [
        clip(&value["errorType"], 120),
        clip(&value["subErrorType"], 120),
    ]
    .into_iter()
    .flatten()
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>();
    let message = if classes.is_empty() {
        "Codex reported an import failure.".into()
    } else {
        let classification = JsString::new(
            classes
                .iter()
                .map(JsString::units)
                .collect::<Vec<_>>()
                .join(&[u16::from(b' '), u16::from(b'/'), u16::from(b' ')][..]),
        );
        crate::codex::provider_errors::surround("Codex import failed (", &classification, ").")
    };
    Some(json!({
        "failureStage":clip(&value["failureStage"], 200).unwrap_or_else(|| "unknown".into()),
        "message":message,
    }))
}

pub(super) fn status(response: &Value, id: &JsString, completed: bool) -> Value {
    let results = entries(response, "itemTypeResults")
        .filter_map(|entry| {
            let kind = item_type(&entry["itemType"])?;
            Some(json!({
                "itemType":kind,
                "successCount":entry["successes"].as_array().map_or(0, |items| items.len()),
                "failures":entries(entry, "failures").take(100).filter_map(failure).collect::<Vec<_>>(),
            }))
        })
        .take(100)
        .collect::<Vec<_>>();
    json!({"importId":id,"status":if completed {"completed"} else {"pending"},"results":results})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_selection_rejects_home_scope_stale_ids_and_embedded_plugins() {
        let cwd = std::env::current_dir().unwrap().join("project");
        let cwd = paths::text(&cwd);
        let raw = json!({"items":vec![
            json!({"itemType":"CONFIG","cwd":Value::Null,"description":"Home"}),
            json!({"itemType":"AGENTS_MD","cwd":cwd,"description":"Project"}),
            json!({"itemType":"CONFIG","cwd":cwd,"description":"Project plugins","details":json!({
                "plugins":vec![json!({"marketplaceName":"sample","pluginNames":vec!["sample-plugin"]})]
            })}),
        ]});
        let found = candidates(&raw, &cwd).unwrap();
        assert_eq!(found.len(), 2);
        let (instruction, plugin) = (found.get_index(0).unwrap().0, found.get_index(1).unwrap().0);
        assert_eq!(
            select(candidates(&raw, &cwd).unwrap(), &[instruction]).unwrap()[0]["description"],
            "Project"
        );
        assert!(select(candidates(&raw, &cwd).unwrap(), &[plugin]).is_err());
        assert!(
            checked(
                "codexExternalImportApplySchema",
                &json!({"itemIds":[instruction,instruction]})
            )
            .is_err()
        );
        assert!(select(IndexMap::new(), &[instruction]).is_err());
    }
}
