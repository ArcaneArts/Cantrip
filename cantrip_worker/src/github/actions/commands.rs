use super::super::{Client, api, common::*, process};
use crate::filesystem::Scope;
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
impl Client {
    pub(in crate::github) async fn actions_mutate(
        &self,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        verify(command, scope).await?;
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        let (path, args, result) = if command["type"] == "github.actions.workflow.dispatch" {
            let request = checked("githubActionsWorkflowDispatchSchema", &command["request"])?;
            let collator = super::super::catalog::collator()?;
            let mut fields = request["inputs"]
                .as_object()
                .unwrap()
                .iter()
                .collect::<Vec<_>>();
            fields.sort_by(|(left, _), (right, _)| {
                collator.compare_utf16(left.units(), right.units())
            });
            let mut args = vec![
                "--method".into(),
                "POST".into(),
                "-f".into(),
                api::prefix("ref=", request["ref"].as_js_string().unwrap()),
            ];
            for (name, value) in fields {
                args.extend([
                    "-f".into(),
                    join(
                        &[
                            "inputs[".into(),
                            name.clone(),
                            "]=".into(),
                            value.as_js_string().unwrap().clone(),
                        ],
                        "",
                    ),
                ]);
            }
            (
                format!(
                    "{repository}/actions/workflows/{}/dispatches",
                    api::text(Some(&request["workflowId"]))?.lossy()
                ),
                args,
                json!({"accepted":true,"runId":Value::Null,"workflowId":request["workflowId"],"action":"dispatch"}),
            )
        } else {
            let request = checked("githubActionsRunActionSchema", &command["request"])?;
            let endpoint = match request["action"].as_str().unwrap() {
                "cancel" => "cancel",
                "rerun-failed" => "rerun-failed-jobs",
                _ => "rerun",
            };
            (
                format!(
                    "{repository}/actions/runs/{}/{endpoint}",
                    api::text(Some(&request["runId"]))?.lossy()
                ),
                vec!["--method".into(), "POST".into()],
                json!({"accepted":true,"runId":request["runId"],"workflowId":Value::Null,"action":request["action"]}),
            )
        };
        let mut arguments = vec!["api".into(), path.into()];
        arguments.extend(args);
        process::run_values(&arguments, 8 * 1024 * 1024, scope).await?;
        let mut result = result;
        result["acceptedAt"] = now();
        checked("githubActionsMutationResultSchema", &result)
    }
    pub(in crate::github) async fn actions_logs(
        &self,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        verify(command, scope).await?;
        let mut args = vec![
            "run".into(),
            "view".into(),
            api::text(Some(&command["runId"]))?,
            "--repo".into(),
            command["repository"].as_js_string().unwrap().clone(),
        ];
        if !command["jobId"].is_null() {
            args.extend(["--job".into(), api::text(Some(&command["jobId"]))?]);
        }
        args.push("--log".into());
        let arguments = args
            .iter()
            .map(|value| crate::filesystem::paths::native(value).into_os_string())
            .collect::<Vec<_>>();
        let captured = Box::pin(scope.capture_timeout(
            "gh".as_ref(),
            &arguments,
            32 * 1024 * 1024,
            std::time::Duration::from_secs(30),
        ))
        .await;
        let (available, raw) = match captured {
            Ok(value) => {
                let stdout = String::from_utf8_lossy(&value.stdout);
                let stderr = String::from_utf8_lossy(&value.stderr);
                let success = value.code == Some(0) && value.overflow.is_none() && !value.timed_out;
                (
                    success,
                    JsString::from(if success {
                        stdout.into_owned()
                    } else {
                        format!("{stdout}\n{stderr}")
                    }),
                )
            }
            // Promisified execFile attaches empty stdout/stderr to spawn errors;
            // Source joins those fields with a newline before its fallback.
            Err(_) => (false, "\n".into()),
        };
        let pattern = r"[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))";
        let regex = regress::Regex::with_flags(pattern, "u").unwrap();
        let mut text = Vec::new();
        let mut at = 0;
        for found in regex.find_from_utf16(raw.units(), 0) {
            text.extend_from_slice(&raw.units()[at..found.range.start]);
            at = found.range.end;
        }
        text.extend_from_slice(&raw.units()[at..]);
        let truncated = text.len() > 1_000_000;
        let text = JsString::new(text[text.len().saturating_sub(1_000_000)..].to_vec());
        checked(
            "githubActionsRunLogsSchema",
            &json!({"runId":command["runId"],"jobId":command["jobId"],"available":available,"text":text,"truncated":truncated,"updatedAt":now()}),
        )
    }
}
