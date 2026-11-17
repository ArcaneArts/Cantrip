use super::{checked, list_directory};
use crate::filesystem::Scope;
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    path::Path,
};

fn arguments(root: &Path, args: &[&str], relative: Option<&JsString>) -> Vec<OsString> {
    let mut result = vec![OsString::from("-C"), root.as_os_str().to_owned()];
    result.extend(args.iter().map(OsString::from));
    if let Some(relative) = relative {
        result.push(if relative.is_empty() {
            OsString::from(".")
        } else {
            crate::filesystem::paths::native(relative).into_os_string()
        });
    }
    result
}
fn immediate(directory: &JsString, file: &str, visible: &HashSet<JsString>) -> Option<JsString> {
    let file = JsString::from(file);
    let prefix = if directory.is_empty() {
        Vec::new()
    } else {
        [directory.units(), &[47]].concat()
    };
    let rest = file.units().strip_prefix(prefix.as_slice())?;
    let name = rest.split(|u| *u == 47).next()?;
    if name.is_empty() {
        return None;
    }
    let path = JsString::new([prefix.as_slice(), name].concat());
    visible.contains(&path).then_some(path)
}
fn slice(value: &str, limit: usize) -> JsString {
    JsString::new(value.encode_utf16().take(limit).collect())
}
fn commit(record: &[u8]) -> Option<(Value, Vec<String>)> {
    let text = String::from_utf8_lossy(record);
    let fields: Vec<_> = text.split('\0').collect();
    let (hash, short, authored) = (*fields.first()?, *fields.get(1)?, *fields.get(4)?);
    if hash.is_empty() || short.is_empty() || authored.is_empty() {
        return None;
    }
    let author = fields
        .get(2)
        .copied()
        .filter(|s| !s.is_empty())
        .unwrap_or("Unknown");
    let commit = json!({"hash":hash,"shortHash":short,"authorName":slice(author,1000),"authorEmail":slice(fields.get(3).copied().unwrap_or(""),1000),"authoredAt":authored,"subject":slice(fields.get(5).copied().unwrap_or(""),10_000)});
    let paths = fields
        .into_iter()
        .skip(6)
        .filter(|s| !s.is_empty())
        .enumerate()
        .map(|(i, p)| {
            if i == 0 {
                p.strip_prefix('\n').unwrap_or(p)
            } else {
                p
            }
            .to_owned()
        })
        .collect();
    Some((commit, paths))
}
pub async fn directory_commits(root: &Path, relative: &JsString, scope: &Scope) -> Result<Value> {
    let directory = list_directory(root, relative).await?;
    let unavailable = || {
        checked(
            "explorerDirectoryCommitsSchema",
            &json!({"path":relative,"available":false,"entries":Value::Array(Vec::new())}),
        )
    };
    let head = arguments(root, &["rev-parse", "--verify", "--quiet", "HEAD"], None);
    if scope
        .run_with_timeout(OsStr::new("git"), &head, 1024 * 1024, None)
        .await
        .is_err()
    {
        return unavailable();
    }
    let visible: HashSet<_> = directory["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_js_string().unwrap().clone())
        .collect();
    let outcome = async {
        let mut tracked = HashSet::new();
        let args = arguments(root,&["ls-files","--cached","-z","--"],Some(relative));
        scope.records(OsStr::new("git"),&args,0,false,|record| {
            if let Some(path) = immediate(relative,&String::from_utf8_lossy(record),&visible){tracked.insert(path);}
            false
        }).await?;
        let mut unresolved = tracked.clone();
        let mut commits = HashMap::new();
        if !tracked.is_empty() {
            let args = arguments(root,&["log","--date=iso-strict","--find-renames","--format=%x1e%H%x00%h%x00%an%x00%ae%x00%aI%x00%s%x00","--name-only","-z","HEAD","--"],Some(relative));
            let mut prefix = true;
            scope.records(OsStr::new("git"),&args,0x1e,true,|record| {
                if prefix {prefix=false;return false;}
                if let Some((commit,paths)) = commit(record) {
                    for path in paths {
                        if let Some(path) = immediate(relative,&path,&visible)
                            && unresolved.remove(&path) {commits.insert(path,commit.clone());}
                    }
                }
                unresolved.is_empty()
            }).await?;
        }
        let entries: Vec<_> = directory["entries"].as_array().unwrap().iter().map(|e| {
            let path = e["path"].as_js_string().unwrap();
            json!({"path":path,"tracked":tracked.contains(path),"lastCommit":commits.get(path).cloned().unwrap_or(Value::Null)})
        }).collect();
        checked("explorerDirectoryCommitsSchema",&json!({"path":relative,"available":true,"entries":entries}))
    }.await;
    match outcome {
        Ok(v) => Ok(v),
        Err(_) => unavailable(),
    }
}
