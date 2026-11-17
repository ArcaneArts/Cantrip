use super::process::{raw, text, trim};
use crate::filesystem::Scope;
use anyhow::{Result, anyhow};
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
use icu_collator::{Collator, options::CollatorOptions};
use std::path::Path;

pub async fn status(cwd: &Path, scope: &Scope) -> Result<Value> {
    let (branch, head, upstream, porcelain, branches) = tokio::join!(
        text(cwd, &["branch", "--show-current"], scope),
        text(cwd, &["rev-parse", "--verify", "HEAD"], scope),
        text(
            cwd,
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}"
            ],
            scope
        ),
        raw(
            cwd,
            &[
                "--no-optional-locks",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all"
            ],
            scope
        ),
        raw(
            cwd,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)",
                "refs/heads",
                "refs/remotes"
            ],
            scope
        )
    );
    let branch = branch?;
    let head = head.unwrap_or_default();
    let upstream = upstream.unwrap_or_default();
    let (ahead, behind) = if !head.is_empty() && !upstream.is_empty() {
        let counts = text(
            cwd,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("HEAD...{upstream}"),
            ],
            scope,
        )
        .await
        .unwrap_or_else(|_| "0\t0".into());
        let mut counts = counts.split_whitespace();
        (
            counts.next().unwrap_or("0").parse::<u64>().unwrap_or(0),
            counts.next().unwrap_or("0").parse::<u64>().unwrap_or(0),
        )
    } else {
        (0, 0)
    };
    let porcelain = porcelain?;
    let mut records = porcelain.split('\0');
    let mut files = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }
        let index = &record[..1];
        let working = &record[1..2];
        let path = &record[3..];
        let original = if [index, working].iter().any(|s| matches!(*s, "R" | "C")) {
            records.next().filter(|s| !s.is_empty())
        } else {
            None
        };
        let conflict =
            index == "U" || working == "U" || matches!((index, working), ("D", "D") | ("A", "A"));
        files.push(json!({"path":path,"originalPath":original,"indexStatus":index,"worktreeStatus":working,"staged":conflict||(index!=" "&&index!="?"),"unstaged":conflict||working!=" "}));
    }
    let mut branches=branches?.split('\n').filter_map(|line|{
        let line=trim(line);let values:Vec<_>=line.split('\0').collect();
        if values.len()<3||values[0].is_empty()||values[1].is_empty()||values[2].is_empty()||values.get(5).is_some_and(|s|!s.is_empty()){return None;}
        Some(json!({"name":values[1],"kind":if values[0].starts_with("refs/remotes/"){"remote"}else{"local"},"current":values.get(4)==Some(&"*"),"hash":values[2],"upstream":values.get(3).filter(|s|!s.is_empty()).copied()}))
    }).collect::<Vec<_>>();
    let locale: icu_locale_core::Locale = cantrip_wire::environment::locale()
        .unwrap_or("en-US")
        .parse()
        .unwrap_or_else(|_| "en-US".parse().unwrap());
    let collator = Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|e| anyhow!("Git branch sorting locale: {e}"))?;
    branches.sort_by(|left, right| {
        (right["current"] == true)
            .cmp(&(left["current"] == true))
            .then_with(|| (left["kind"] == "remote").cmp(&(right["kind"] == "remote")))
            .then_with(|| {
                collator.compare_utf16_icu4c(
                    left["name"].as_js_string().unwrap().units(),
                    right["name"].as_js_string().unwrap().units(),
                )
            })
    });
    scope.check()?;
    checked(
        "gitStatusSchema",
        &json!({"branch":branch,"head":if head.is_empty(){None}else{Some(head)},"upstream":if upstream.is_empty(){None}else{Some(upstream)},"ahead":ahead,"behind":behind,"files":files,"branches":branches}),
    )
}
