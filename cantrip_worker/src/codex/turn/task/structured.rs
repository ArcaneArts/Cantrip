//! Planner and finalizer prompts and endpoint-only model result projection.
use crate::{
    http::checked,
    native_items::{concat, join},
};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use std::sync::OnceLock;

const PLANNER: &str = r#"You are planning a Cantrip Task. Investigate the repository and its effective Policies before proposing architecture. This turn is strictly read-only: do not edit files, mutate Git or GitHub, call side-effecting tools, or implement any part of the plan.

Return one complete replacement Markdown plan through the supplied structured output. Cover product behavior, architecture, persistence, APIs, UI, safety, tests, rollout, and independently mergeable milestones when relevant. Ask only questions whose answers materially change the plan. Give a recommended option when you have a defensible recommendation. Return an empty questions array when clarification is unnecessary. Do not claim to have inspected files or run checks that you did not inspect or run.

Effective Cantrip Policy summaries are supplied as application context. Prefer the managed Cantrip MCP `policy_list` and `policy_read` tools when available; otherwise run `cantrip policy list` and `cantrip policy read <policy-key>`. Read every summary that requires its full current body. Policies may constrain the future implementation even though this planning turn cannot write."#;
const FINALIZER: &str = r#"You are finalizing a Cantrip Task for implementation. This turn is strictly read-only: do not edit files, mutate Git or GitHub, call side-effecting tools, or implement any part of the plan.

Return a complete final implementation plan and a Goal prompt through the supplied structured output. Incorporate every supplied answer and the additional direction, remove unresolved questions, make acceptance criteria explicit, and direct the Goal Agent to finish the whole plan rather than only its first milestone.

Keep the Goal prompt at most 2,000 characters. Summarize the objective, constraints, and success criteria; do not copy the full plan into it. Cantrip supplies the complete final plan separately as durable implementation context.

Effective Cantrip Policy summaries are supplied as application context. Prefer the managed Cantrip MCP `policy_list` and `policy_read` tools when available; otherwise run `cantrip policy list` and `cantrip policy read <policy-key>`. Read every summary that requires its full current body. Policies may constrain the implementation, but do not copy policy bodies or revision identifiers into the result."#;
const OBJECTIVE: &str = r#"# Cantrip Task implementation objective

Implement the complete approved Task plan supplied as implementation context. Before making changes, inspect the effective Cantrip Policies supplied by the application. Prefer the managed Cantrip MCP `policy_list` and `policy_read` tools; use `cantrip policy list` and `cantrip policy read <policy-key>` as the CLI fallback. Read every policy whose summary requires the full body and follow the current policies throughout implementation.

Continue until every acceptance criterion is satisfied or the Goal is genuinely blocked. Keep progress recoverable, validate each completed change, and report the final outcome. Do not stop after only the first milestone.

## Agent-generated implementation direction

"#;
const EMPTY_GOAL: &str = "Implement the complete final plan, validate the finished result, and continue until every acceptance criterion is satisfied.";

static SCHEMAS: OnceLock<Value> = OnceLock::new();

fn schemas() -> &'static Value {
    SCHEMAS.get_or_init(|| {
        parse_json_text(include_str!("model-output.json"))
            .expect("generated Task model output schemas")
    })
}

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Direct,
    InitialPlan,
    ContinuePlan,
    Finalize,
}

impl Kind {
    pub(super) fn parse(value: &Value) -> Result<Self> {
        Ok(match value.as_str() {
            Some("direct") => Self::Direct,
            Some("initial-plan") => Self::InitialPlan,
            Some("continue-plan") => Self::ContinuePlan,
            Some("finalize") => Self::Finalize,
            _ => bail!("Invalid encrypted Task operation kind."),
        })
    }

    pub(super) fn is_structured(self) -> bool {
        !matches!(self, Self::Direct)
    }

    pub(super) fn output_schema(self) -> Option<&'static Value> {
        match self {
            Self::Direct => None,
            Self::InitialPlan | Self::ContinuePlan => Some(&schemas()["planner"]),
            Self::Finalize => Some(&schemas()["finalizer"]),
        }
    }

    pub(super) fn prompt(self, input: &Value) -> JsString {
        match self {
            Self::Direct => text(&input["inputBriefMarkdown"]),
            Self::InitialPlan => concat(&[
                PLANNER.into(),
                "\n\n## User brief\n\n".into(),
                text(&input["inputBriefMarkdown"]),
                "\n\nThe attachments supplied with this turn are the exact attachments saved on the Task draft.".into(),
            ]),
            Self::ContinuePlan => reviewed_prompt(
                input,
                PLANNER,
                "\n\nRevise the existing plan into one complete replacement plan using the user's answers and additional direction. Do not return a patch or a partial addendum.\n\n## Existing plan\n\n",
                "No existing plan is available.",
                "\n\n## Answers to the prior questions\n\n",
            ),
            Self::Finalize => reviewed_prompt(
                input,
                FINALIZER,
                "\n\nProduce one complete final plan, not a patch or addendum. The Goal prompt may refer to that final plan but must remain useful when wrapped by Cantrip's Task execution objective.\n\n## Current plan\n\n",
                "No current plan is available.",
                "\n\n## Answers\n\n",
            ),
        }
    }

    pub(super) fn complete(self, input: &Value, raw: &Value) -> Result<Completion> {
        let raw = raw
            .as_js_string()
            .context("Missing native Task output text.")?;
        let mut completed = Completion {
            plan: Value::Null,
            questions: Vec::new(),
            objective: None,
            assistant: raw.clone(),
        };
        if !self.is_structured() {
            if raw.is_empty() {
                completed.assistant = "The Task completed without a message.".into();
            }
            return Ok(completed);
        }
        let mut response = checked(
            "boundedJsonObjectSchema",
            &parse_json_text(&raw.lossy())
                .map_err(|_| anyhow::anyhow!("Invalid structured Task output."))?,
        )?;
        let fallback = input["inputPlanMarkdown"]
            .as_js_string()
            .map(JsString::trim)
            .filter(|plan| !plan.is_empty())
            .unwrap_or_else(|| text(&input["inputBriefMarkdown"]));
        if matches!(self, Self::Finalize) {
            apply_fallback(&mut response, "finalPlanMarkdown", &fallback);
            let final_plan = response["finalPlanMarkdown"]
                .as_js_string()
                .map(JsString::trim);
            if final_plan.is_some_and(|plan| !plan.is_empty()) {
                apply_fallback(&mut response, "goalPrompt", &EMPTY_GOAL.into());
            }
            let projected = checked("taskFinalizerResultSchema", &response)?;
            let objective = concat(&[OBJECTIVE.into(), text(&projected["goalPrompt"])]);
            let limit = schemas()["nativeGoalObjectiveLimit"].as_u64().unwrap();
            if std::char::decode_utf16(objective.units().iter().copied()).count() as u64 > limit {
                bail!("The encrypted Task Goal objective is too large.");
            }
            completed.assistant = text(&projected["finalPlanMarkdown"]);
            completed.plan = projected["finalPlanMarkdown"].clone();
            completed.objective = Some(objective);
        } else {
            apply_fallback(&mut response, "planMarkdown", &fallback);
            let projected = checked("taskPlannerResultSchema", &response)?;
            completed.plan = projected["planMarkdown"].clone();
            completed.questions = projected["questions"].as_array().unwrap().clone();
            completed.assistant = planner_message(&projected);
        }
        Ok(completed)
    }
}

pub(super) struct Completion {
    pub(super) plan: Value,
    pub(super) questions: Vec<Value>,
    pub(super) objective: Option<JsString>,
    pub(super) assistant: JsString,
}

fn apply_fallback(response: &mut Value, field: &str, fallback: &JsString) {
    if response[field]
        .as_js_string()
        .is_some_and(|value| value.trim().is_empty())
        && !fallback.trim().is_empty()
    {
        response[field] = json!(fallback);
    }
}

fn text(value: &Value) -> JsString {
    value.as_js_string().unwrap().clone()
}

fn reviewed_prompt(
    input: &Value,
    rules: &str,
    intro: &str,
    missing: &str,
    heading: &str,
) -> JsString {
    let plan = input["inputPlanMarkdown"]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| missing.into());
    let direction = text(&input["additionalDirection"]).trim();
    let direction = if direction.is_empty() {
        "No additional direction was supplied.".into()
    } else {
        direction
    };
    concat(&[
        rules.into(),
        intro.into(),
        plan,
        heading.into(),
        answers(input),
        "\n\n## Additional direction\n\n".into(),
        direction,
    ])
}

fn answers(input: &Value) -> JsString {
    let answers = input["inputAnswers"].as_array().unwrap();
    if answers.is_empty() {
        return "No answers were supplied.".into();
    }
    let questions = input["inputQuestions"].as_array().unwrap();
    join(
        answers.iter().map(|answer| {
            let question = questions
                .iter()
                .find(|question| question["id"] == answer["questionId"]);
            let header = question.map_or_else(
                || text(&answer["questionId"]),
                |question| text(&question["header"]),
            );
            let label = question
                .and_then(|question| {
                    question["options"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|option| option["id"] == answer["optionId"])
                })
                .map(|option| text(&option["label"]));
            let freeform = answer["freeform"].as_js_string().map(JsString::trim);
            let choices = join(
                label
                    .into_iter()
                    .chain(freeform)
                    .filter(|value| !value.is_empty()),
                " — ",
            );
            concat(&["- ".into(), header, ": ".into(), choices])
        }),
        "\n",
    )
}

fn planner_message(result: &Value) -> JsString {
    let plan = text(&result["planMarkdown"]);
    let questions = result["questions"].as_array().unwrap();
    if questions.is_empty() {
        return plan;
    }
    let items = join(
        questions.iter().map(|question| {
            concat(&[
                "- **".into(),
                text(&question["header"]),
                ":** ".into(),
                text(&question["question"]),
            ])
        }),
        "\n",
    );
    concat(&[plan, "\n\n## Questions\n\n".into(), items])
}
