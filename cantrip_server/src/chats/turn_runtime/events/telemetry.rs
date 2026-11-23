use super::*;
impl EventSink {
    fn attribution(&self) -> Value {
        json!({"workerId":self.turn.execution["workerId"],"executionAttemptId":self.attempt_id,"attemptKind":"chat-turn","attemptStatus":"running","codexVersion":self.turn.attributed_worker.as_ref().map(|v|v["codexVersion"].clone()).unwrap_or(Value::Null)})
    }
    pub(super) async fn usage(&self, usage: Option<&Value>, turn: &Value, capture: Option<&Value>) {
        let mut attribution = self.attribution();
        attribution["turnId"] = turn.clone();
        if let Some(capture) = capture {
            attribution["nativeModelAttribution"] = capture.clone();
        }
        let runtime = self.runtime.lock().unwrap().clone();
        self.dependencies
            .telemetry
            .record_usage(
                &self.turn.owner,
                &self.source,
                &self.turn.execution,
                &runtime,
                usage,
                &attribution,
            )
            .await;
    }
    pub(super) async fn native_root(&self, capture: Option<&Value>) {
        if let Some(capture) = capture.filter(|v| v["isRoot"] == true) {
            self.usage(None, &capture["turnId"], Some(capture)).await;
        }
    }
    pub(super) async fn child(
        &self,
        telemetry: Option<&Value>,
        turn: Option<&Value>,
        capture: Option<&Value>,
    ) {
        let Some(telemetry) = telemetry.filter(|v| truthy(Some(v)) && v["isRoot"] != true) else {
            return;
        };
        let Some(turn) = turn.filter(|v| truthy(Some(v))) else {
            return;
        };
        let attempt = identifier(&[
            &self.attempt_id,
            &json!(":subagent:"),
            &telemetry["agentThreadId"],
            &json!(":"),
            turn,
        ]);
        let source = identifier(&[&json!("chat-subagent:"), &attempt]);
        let date = |v: &Value| {
            v.as_f64()
                .filter(|n| n.is_finite() && n.abs() <= 8.64e15)
                .and_then(|n| crate::wire::date_iso_milliseconds(n.trunc() as i64))
                .map(|v| json!(v))
        };
        let completed = if telemetry["status"] == "running" {
            Value::Null
        } else {
            date(&telemetry["completedAtMs"]).unwrap_or_else(|| {
                json!(
                    crate::wire::date_iso_milliseconds((self.dependencies.clock)())
                        .expect("Turn clock")
                )
            })
        };
        let mut attribution = self.attribution();
        for (key, value) in [
            ("executionAttemptId", attempt),
            ("turnId", turn.clone()),
            ("attemptKind", json!("subagent-turn")),
            ("attemptStatus", telemetry["status"].clone()),
            ("completedAt", completed.clone()),
            ("finalizedAt", completed),
        ] {
            attribution[key] = value;
        }
        if let Some(started) = date(&telemetry["startedAtMs"]) {
            attribution["startedAt"] = started;
        }
        let runtime = if let Some(capture) = capture.filter(|v| truthy(Some(v))) {
            attribution["nativeModelAttribution"] = capture.clone();
            self.runtime.lock().unwrap().clone()
        } else {
            self.subagent
                .clone()
                .unwrap_or_else(|| self.runtime.lock().unwrap().clone())
        };
        self.dependencies
            .telemetry
            .record_usage(
                &self.turn.owner,
                source.as_js_string().unwrap(),
                &self.turn.execution,
                &runtime,
                None,
                &attribution,
            )
            .await;
    }
    pub(super) async fn protected_telemetry(
        &self,
        event: &Value,
        state: &mut AttemptState,
        at: i64,
    ) -> Result<()> {
        let t = &event["telemetry"];
        state.behavior_turn = nullish(t.get("turnId"), &state.behavior_turn).clone();
        if t["kind"] == "activity" {
            self.child(
                t.get("agentRuntime"),
                t.get("turnId"),
                t.get("nativeModelAttribution"),
            )
            .await;
            self.native_root(t.get("nativeModelAttribution")).await;
        }
        match t["kind"].as_str() {
            Some("message") => {
                let final_answer = t["phase"] != "commentary" && !truthy(t.get("streaming"));
                state.tracker.mark_visible(final_answer, at);
                if final_answer {
                    state
                        .finals
                        .record(t.get("turnId"), &event["message"]["id"])?;
                }
            }
            Some("usage") => {
                let mut usage = Value::object([] as [(&str, Value); 0]);
                for key in [
                    "inputTokens",
                    "cachedInputTokens",
                    "cacheWriteInputTokens",
                    "outputTokens",
                    "reasoningOutputTokens",
                ] {
                    if let Some(v) = t["usage"].get(key) {
                        usage[key] = v.clone();
                    }
                }
                for key in ["modelContextWindow", "contextUsedPercent"] {
                    if let Some(v) = t.get(key) {
                        usage[key] = v.clone();
                    }
                }
                state.tracker.observe_usage(&usage, at);
                self.usage(
                    t.get("usage"),
                    nullish(
                        t.get("turnId"),
                        nullish(Some(&state.behavior_turn), &event["message"]["id"]),
                    ),
                    t.get("nativeModelAttribution"),
                )
                .await;
            }
            Some("activity") => state.tracker.mark_activity(at),
            _ if event["type"] == "agent.protected-message" => {
                state.tracker.mark_visible(true, at);
                state
                    .finals
                    .record(t.get("turnId"), &event["message"]["id"])?;
            }
            _ => {}
        }
        Ok(())
    }
    pub(super) async fn activity_telemetry(
        &self,
        activity: &Value,
        state: &mut AttemptState,
        at: i64,
    ) -> Result<()> {
        state.behavior_turn =
            nullish(activity["correlation"].get("turnId"), &state.behavior_turn).clone();
        if activity["type"] == "turnSummary" {
            self.native_root(activity.get("nativeModelAttribution"))
                .await;
            if let Some(scope) = activity.get("agentScope").filter(|v| truthy(Some(v))) {
                let millis = |key: &str| {
                    activity[key]
                        .as_f64()
                        .map(|v| json!(v * 1000.0))
                        .unwrap_or(Value::Null)
                };
                self.child(Some(&json!({"agentThreadId":scope["agentThreadId"],"isRoot":scope["isRoot"],"startedAtMs":millis("startedAt"),"completedAtMs":millis("completedAt"),"status":if activity["status"]=="running" {"running"}else if activity["status"]=="completed" {"completed"}else{"failed"}})),activity["correlation"].get("turnId"),activity.get("nativeModelAttribution")).await;
            }
        }
        state.tracker.observe_activity(activity, at)?;
        if activity["type"] == "usage" {
            self.usage(
                activity.get("last"),
                nullish(activity["correlation"].get("turnId"), &activity["id"]),
                activity.get("nativeModelAttribution"),
            )
            .await;
        }
        if activity["type"] == "rateLimit"
            && truthy(self.runtime.lock().unwrap()["provider"].get("accountId"))
        {
            self.dependencies
                .quota
                .record_activity(
                    self.runtime.clone(),
                    runtime_quota::Execution {
                        owner: self.turn.owner.clone(),
                        worker: text(&self.turn.execution["workerId"])?,
                        chat: Some(text(&self.turn.execution["chatId"])?),
                        attempt: text(&self.attempt_id)?,
                        turn: None,
                    },
                    activity.clone(),
                )
                .await;
        }
        if activity["type"] == "fileChange" {
            let mut turn = self.turn_state.lock().unwrap();
            for change in activity["changes"].as_array().context("File changes")? {
                turn.changed_paths.insert(
                    change["path"]
                        .as_js_string()
                        .context("Changed path")?
                        .clone(),
                );
            }
        }
        Ok(())
    }
}
