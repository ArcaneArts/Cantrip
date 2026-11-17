//! Item-specific gap detection. A thread watermark never proves item recovery.
//! This is observation state, not execution authority or a committed cursor.
use cantrip_wire::{JsString, Value, value::json};
use std::collections::HashMap;

#[derive(Default)]
pub struct Tracker {
    items: HashMap<String, Value>,
    gaps: HashMap<String, (Value, f64)>,
}
fn sequence(cursor: &Value) -> u64 {
    cursor["sequence"].as_str().unwrap().parse().unwrap()
}
fn key(epoch: &Value, turn: &Value, item: &JsString) -> String {
    json!([epoch.clone(), turn.clone(), json!(item)]).stringify()
}
impl Tracker {
    /// Accept only frames already validated by native::source.
    pub fn notification(&mut self, event: &Value) -> bool {
        let Some(cursor) = event.get("nativeCursor") else {
            return false;
        };
        let params = &event["params"];
        if !params["turnId"].is_string() {
            return false;
        }
        let Some(item) = params["itemId"]
            .as_js_string()
            .or_else(|| params["item"]["id"].as_js_string())
            .filter(|v| !v.is_empty())
        else {
            return false;
        };
        let key = key(&cursor["epoch"], &params["turnId"], item);
        let previous = self.items.get(&key);
        if previous.is_some_and(|p| sequence(cursor) <= sequence(p)) {
            return false;
        }
        let self_contained = event["method"] == "item/completed"
            || (event["method"] == "item/started" && cursor["previousSequence"].is_null());
        // JS null differs from missing previous?.sequence (undefined).
        if !self_contained && previous.is_none_or(|p| cursor["previousSequence"] != p["sequence"]) {
            if self
                .gaps
                .get(&key)
                .is_none_or(|(gap, _)| sequence(cursor) > sequence(gap))
            {
                self.gaps
                    .insert(key, (cursor.clone(), event["sequence"].as_f64().unwrap()));
            }
            return true;
        }
        self.advance(key, cursor);
        false
    }
    fn advance(&mut self, key: String, cursor: &Value) {
        self.items.insert(key.clone(), cursor.clone());
        if self
            .gaps
            .get(&key)
            .is_some_and(|(gap, _)| sequence(cursor) >= sequence(gap))
        {
            self.gaps.remove(&key);
        }
    }
    /// A read begun before the gap cannot establish replacement of an epoch.
    pub fn snapshot(&mut self, observation: &Value) -> bool {
        let live = &observation["snapshot"]["history"]["live"];
        if !live.is_null() {
            let barrier = observation["readBarrierSequence"].as_f64().unwrap();
            self.gaps.retain(|_, (cursor, observed)| {
                live["epoch"] == cursor["epoch"] || barrier < *observed
            });
        }
        if let Some(items) = live["items"].as_array() {
            for item in items {
                let key = key(
                    &item["cursor"]["epoch"],
                    &item["turnId"],
                    item["item"]["id"].as_js_string().unwrap(),
                );
                if self
                    .items
                    .get(&key)
                    .is_none_or(|p| sequence(&item["cursor"]) > sequence(p))
                {
                    self.advance(key, &item["cursor"]);
                }
            }
        }
        !self.gaps.is_empty()
    }
}
