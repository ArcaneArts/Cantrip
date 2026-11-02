use anyhow::{Context, Result};
use cantrip_server::{
    chats::turn_behavior::{ModelBehaviorTracker, is_test_command},
    wire::Value,
};
pub fn tracker(input: &Value) -> Result<(ModelBehaviorTracker, Vec<Value>)> {
    let mut tracker = ModelBehaviorTracker::default();
    let mut snapshots: Vec<Value> = Vec::new();
    for action in input["actions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let at = action["at"]
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|date| date.timestamp_millis())
            .unwrap_or(1792886400123);
        match action["kind"].as_str() {
            Some("activity") => tracker.observe_activity(&action["value"], at)?,
            Some("usage") => tracker.observe_usage(&action["value"], at),
            Some("visible") => tracker.mark_visible(action["final"] == true, at),
            Some("approval") => tracker.mark_approval(
                action["key"]
                    .as_js_string()
                    .context("Behavior approval key")?,
                at,
            ),
            Some("mark") => tracker.mark_activity(at),
            Some("native-event") => tracker.observe_native_event(&action["value"])?,
            Some("native-turn") => {
                tracker.observe_native_turn(action.get("turn"), action.get("capture"))?
            }
            Some("mutate-snapshot") => {
                snapshots.last_mut().context("Behavior fixture snapshot")?["nativeAttribution"]["captures"] =
                    Value::Array(Vec::new())
            }
            _ => anyhow::bail!("Unknown behavior fixture action"),
        }
        snapshots.push(tracker.snapshot());
    }
    Ok((tracker, snapshots))
}
pub fn run(input: &Value) -> Result<Value> {
    let (tracker, snapshots) = tracker(input)?;
    let tests = input["commands"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .map(|command| {
            Ok(Value::Bool(is_test_command(
                command.as_js_string().context("Behavior test command")?,
            )))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Value::object([
        ("snapshots", Value::Array(snapshots)),
        ("snapshot", tracker.snapshot()),
        ("tests", Value::Array(tests)),
    ]))
}
