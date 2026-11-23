//! Existing bounded stash summaries, also used to identify a durable stash by hash.
use super::{diff, history, process};
use crate::filesystem::Scope;
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
use indexmap::IndexMap;
use std::path::Path;
pub async fn list(cwd: &Path, scope: &Scope) -> Result<Value> {
    let output = process::raw(
        cwd,
        &[
            "stash",
            "list",
            "--max-count=201",
            "--format=%gd%x00%H%x00%h%x00%P%x00%aI%x00%gs%x1e",
        ],
        scope,
    )
    .await?;
    let records = output
        .split('\x1e')
        .map(process::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|record| {
            let fields = record.split('\0').map(str::to_owned).collect::<Vec<_>>();
            (fields.len() >= 6 && fields[..6].iter().all(|s| !s.is_empty())).then_some(fields)
        })
        .collect::<Vec<_>>();
    let mut stashes = Vec::new();
    for fields in records.iter().take(200) {
        let stat = process::raw(
            cwd,
            &[
                "stash",
                "show",
                "--include-untracked",
                "--numstat",
                "-z",
                &fields[1],
            ],
            scope,
        )
        .await?;
        let mut input = stat.split('\0');
        let mut stats = IndexMap::new();
        while let Some(record) = input.next() {
            let Some((add, remaining)) = record.split_once('\t') else {
                continue;
            };
            let Some((delete, mut path)) = remaining.split_once('\t') else {
                continue;
            };
            if path.is_empty() {
                input.next();
                path = input.next().unwrap_or("");
            }
            if !diff::safe(&path.into()) {
                continue;
            }
            stats.insert(
                path,
                (
                    (add != "-").then(|| history::integer(add)),
                    (delete != "-").then(|| history::integer(delete)),
                ),
            );
        }
        let total = stats.len();
        let files=stats.into_iter().take(2000).map(|(path,(additions,deletions))|json!({"path":path,"additions":additions,"deletions":deletions,"binary":additions.is_none()||deletions.is_none()})).collect::<Vec<_>>();
        let parents = fields[3]
            .split(' ')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        let message = fields[5]
            .split_once(": ")
            .map_or(fields[5].as_str(), |(_, message)| message);
        let sum = |key: &str| {
            files
                .iter()
                .map(|f| f[key].as_f64().unwrap_or(0.0))
                .sum::<f64>()
        };
        stashes.push(json!({"ref":fields[0],"hash":fields[1],"shortHash":fields[2],"message":message,"createdAt":fields[4],"baseHash":parents.first().copied(),"filesChanged":total,"filesTruncated":total>2000,"additions":sum("additions"),"deletions":sum("deletions"),"includesUntracked":parents.len()>=3,"files":files}));
    }
    checked(
        "gitStashListSchema",
        &json!({"stashes":stashes,"truncated":records.len()>200}),
    )
}
pub(super) async fn drop_hash(cwd: &Path, hash: &str, scope: &Scope) -> Result<String> {
    let stashes = list(cwd, scope).await?;
    let stash = stashes["stashes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["hash"] == hash);
    match stash {
        Some(stash) => {
            process::run(
                cwd,
                &["stash", "drop", stash["ref"].as_str().unwrap()],
                scope,
            )
            .await
        }
        None => Ok("The source stash was already absent.".into()),
    }
}
