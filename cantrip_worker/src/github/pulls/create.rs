use super::{Client, api, helpers, parse};
use crate::{filesystem::Scope, github::process};
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};

pub(super) async fn git(cwd: JsString, args: Vec<JsString>, scope: Scope) -> Result<Value> {
    let mut arguments = vec!["-C".into(), cwd];
    arguments.extend(args);
    Ok(json!(
        process::run_program("git", &arguments, 1024 * 1024, &scope).await?
    ))
}
impl Client {
    pub(in crate::github) async fn create_pull(
        &self,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        let request = &command["request"];
        let cwd = command["cwd"].as_js_string().unwrap();
        let head = request["head"].as_js_string().unwrap();
        let base = request["base"].as_js_string().unwrap();
        self.join_reads(
            git(
                cwd.clone(),
                vec!["check-ref-format".into(), "--branch".into(), head.clone()],
                scope.clone(),
            ),
            git(
                cwd.clone(),
                vec!["check-ref-format".into(), "--branch".into(), base.clone()],
                scope.clone(),
            ),
        )
        .await?;
        let local = git(
            cwd.clone(),
            vec!["rev-parse".into(), api::prefix("refs/heads/", head)],
            scope.clone(),
        )
        .await?;
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        let encoded = head
            .units()
            .split(|unit| *unit == 47)
            .map(|part| helpers::encode_component(&JsString::new(part.to_vec())))
            .collect::<Result<Vec<_>>>()?
            .join("/");
        let remote = self
            .api(&format!("{repository}/git/ref/heads/{encoded}"), &[], scope)
            .await?;
        let object = api::member(&remote, "object")?.filter(|v| v.is_object() || v.is_array());
        let sha = object
            .and_then(|v| v.get("sha"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if sha.len() != 40
            || !sha
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || sha != local.as_js_string().unwrap().trim().lossy()
        {
            // Head is a validated branch; keep its original UTF-16 in the public error.
            let message = helpers::join(&[
                "Push ".into(), head.clone(), " to ".into(), command["repository"].as_js_string().unwrap().clone(),
                " before creating its pull request. The local and GitHub branch tips must match.".into()
            ], "");
            return Err(crate::error::WireError(message).into());
        }
        let mut linked = Vec::new();
        for number in super::array(&request["linkedIssueNumbers"]) {
            let line = api::prefix("Closes #", &api::text(Some(number))?);
            if !linked.contains(&line) {
                linked.push(line);
            }
        }
        let body = helpers::join(
            &[
                request["body"].as_js_string().unwrap().trim(),
                helpers::join(&linked, "\n"),
            ]
            .into_iter()
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>(),
            "\n\n",
        );
        let mut args = helpers::form(
            "POST",
            &[
                ("title", &request["title"]),
                ("head", &request["head"]),
                ("base", &request["base"]),
                ("body", &Value::String(body)),
            ],
        )?;
        args.extend([
            "-F".into(),
            api::prefix("draft=", &api::text(Some(&request["draft"]))?),
        ]);
        let pull = parse::summary(
            &self
                .api(&format!("{repository}/pulls"), &args, scope)
                .await?,
        )?;
        let number = api::text(Some(&pull["number"]))?;
        let mut warnings = Vec::new();
        for (field, endpoint, key, message) in [
            (
                "labels",
                format!("{repository}/issues/{}/labels", number.lossy()),
                "labels",
                "The pull request was created, but labels could not be applied: ",
            ),
            (
                "reviewers",
                format!("{repository}/pulls/{}/requested_reviewers", number.lossy()),
                "reviewers",
                "The pull request was created, but reviewers could not be requested: ",
            ),
        ] {
            let values = helpers::strings(&request[field]);
            if !values.is_empty()
                && let Err(error) = self
                    .api(&endpoint, &helpers::repeated("POST", key, values), scope)
                    .await
            {
                warnings.push(helpers::warning(message, &error));
            }
        }
        checked(
            "githubPullRequestCreateResultSchema",
            &json!({"pullRequest":pull,"warnings":warnings}),
        )
    }
}
