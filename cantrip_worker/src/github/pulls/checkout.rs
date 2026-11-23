//! Fetch an exact PR commit without switching or changing the selected worktree.
use super::{Client, api, create::git, helpers, parse, pull_path, verify};
use crate::{error::WireError, filesystem::Scope};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};

fn slug(value: &JsString) -> String {
    let normalized =
        icu_normalizer::DecomposingNormalizer::new_nfkd().normalize_utf16(value.units());
    let normalized = JsString::new(normalized.into_owned()).lowercase();
    let mut result = String::new();
    let mut invalid = false;
    for &unit in normalized.units() {
        if (97..=122).contains(&unit) || (48..=57).contains(&unit) || [46, 95, 45].contains(&unit) {
            result.push(unit as u8 as char);
            invalid = false;
        } else if !invalid {
            result.push('-');
            invalid = true;
        }
    }
    let mut result = result.trim_matches('-').to_owned();
    result.truncate(48);
    if result.is_empty() {
        "head".into()
    } else {
        result
    }
}
impl Client {
    pub(in crate::github) async fn checkout_pull(
        &self,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        verify(command, scope).await?;
        let pull = parse::summary(&self.api(&pull_path(command)?, &[], scope).await?)?;
        let cwd = command["cwd"].as_js_string().unwrap();
        let expected = command["repository"].as_js_string().unwrap().lowercase();
        let output = git(cwd.clone(), vec!["remote".into()], scope.clone()).await?;
        let mut matches = Vec::new();
        for remote in output
            .as_js_string()
            .unwrap()
            .units()
            .split(|unit| *unit == 10)
        {
            let remote = JsString::new(remote.to_vec()).trim();
            if remote.is_empty() {
                continue;
            }
            let url = git(
                cwd.clone(),
                vec!["remote".into(), "get-url".into(), remote.clone()],
                scope.clone(),
            )
            .await?;
            if crate::filesystem::repository::github_repository_from_remote(
                url.as_js_string().unwrap(),
            )
            .as_ref()
                == Some(&expected)
            {
                matches.push(remote);
            }
        }
        let remote = matches
            .iter()
            .find(|value| value.units() == [111, 114, 105, 103, 105, 110])
            .or_else(|| matches.first());
        let Some(remote) = remote else {
            return Err(WireError(helpers::join(&["No Git remote in this project points to ".into(),command["repository"].as_js_string().unwrap().clone(),". Add the GitHub repository as a remote before checking out its pull requests.".into()],"")).into());
        };
        let number = api::text(Some(&command["number"]))?;
        git(
            cwd.clone(),
            vec![
                "fetch".into(),
                "--no-tags".into(),
                remote.clone(),
                format!("refs/pull/{}/head", number.lossy()).into(),
            ],
            scope.clone(),
        )
        .await?;
        let output = git(
            cwd.clone(),
            vec![
                "rev-parse".into(),
                "--verify".into(),
                "FETCH_HEAD^{commit}".into(),
            ],
            scope.clone(),
        )
        .await?;
        let head = output.as_js_string().unwrap().trim();
        if head != *pull["headSha"].as_js_string().unwrap() {
            bail!(
                "The pull request changed while its checkout was prepared. Retry to use the latest head commit."
            );
        }
        let number = api::text(Some(&pull["number"]))?.lossy().into_owned();
        let branch = format!(
            "cantrip/pr/{number}-{}-{}",
            slug(pull["headRef"].as_js_string().unwrap()),
            &pull["headSha"].as_str().unwrap()[..8]
        );
        let name = parse::crop(
            &api::prefix(
                &format!("PR #{number} "),
                pull["title"].as_js_string().unwrap(),
            ),
            200,
        );
        checked(
            "githubPullRequestCheckoutPreparedSchema",
            &json!({"pullRequest":pull,"branch":branch,"name":name,"headSha":head,"remote":remote}),
        )
    }
}
