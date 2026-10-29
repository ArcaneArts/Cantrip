//! Shared, process-local service log emission and bounded noise control.
use super::log_sanitize;
use crate::wire::{JsString, Value, coercion, value::json};
use anyhow::{Result, bail};
use indexmap::IndexMap;
use std::sync::{Arc, Mutex, OnceLock};
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
pub type Output = Arc<dyn Fn(Value) + Send + Sync>;
pub type Logger = Arc<dyn Fn(LogCall) + Send + Sync>;
#[derive(Clone)]
pub enum Policy {
    Event,
    Sampled {
        key: JsString,
        every: Value,
    },
    Repeated {
        key: JsString,
        options: Option<Value>,
    },
}
#[derive(Clone)]
pub struct LogCall {
    pub level: &'static str,
    pub message: &'static str,
    pub context: Value,
    pub policy: Policy,
}
impl LogCall {
    pub fn event(level: &'static str, message: &'static str, context: Value) -> Self {
        Self {
            level,
            message,
            context,
            policy: Policy::Event,
        }
    }
    pub fn repeated(
        key: JsString,
        level: &'static str,
        message: &'static str,
        context: Value,
        options: Option<Value>,
    ) -> Self {
        Self {
            level,
            message,
            context,
            policy: Policy::Repeated { key, options },
        }
    }
    pub fn sampled(
        key: JsString,
        every: u32,
        level: &'static str,
        message: &'static str,
        context: Value,
    ) -> Self {
        Self {
            level,
            message,
            context,
            policy: Policy::Sampled {
                key,
                every: json!(every),
            },
        }
    }
}
pub fn key(prefix: &str, values: &[&Value]) -> JsString {
    let mut units = prefix.encode_utf16().collect::<Vec<_>>();
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            units.push(58);
        }
        units.extend(
            coercion::string(value)
                .expect("Operational key primitive")
                .units(),
        );
    }
    JsString::new(units)
}
#[derive(Clone)]
struct Repeated {
    context: Option<Value>,
    first: f64,
    last: f64,
    level: String,
    message: JsString,
    suppressed: f64,
}
#[derive(Default)]
struct State {
    repeated: IndexMap<JsString, Repeated>,
    samples: IndexMap<JsString, f64>,
}
pub struct Emitter {
    system: JsString,
    clock: Clock,
    output: Output,
    state: Mutex<State>,
}
fn positive(value: Option<&Value>, fallback: f64) -> Result<f64> {
    let value = match value {
        None | Some(Value::Null) => fallback,
        Some(Value::Number(v)) => *v,
        _ => f64::NAN,
    };
    if !value.is_finite() || value.fract() != 0.0 || value <= 0.0 || value > 9_007_199_254_740_991.0
    {
        bail!("Log noise-control values must be positive integers.");
    }
    Ok(value)
}
fn bounded<T>(map: &mut IndexMap<JsString, T>, key: JsString, value: T) {
    if !map.contains_key(&key) && map.len() >= 1000 {
        map.shift_remove_index(0);
    }
    map.insert(key, value);
}
fn repeated_context(context: Option<&Value>, count: f64) -> Value {
    let mut context = match context {
        Some(Value::Object(_)) => context.unwrap().clone(),
        None => Value::object([] as [(&str, Value); 0]),
        Some(value) => json!({"originalContext":value}),
    };
    let mut counts = match context.get("counts") {
        Some(Value::Object(_)) => context["counts"].clone(),
        _ => Value::object([] as [(&str, Value); 0]),
    };
    counts["repeated"] = json!(count);
    context["counts"] = counts;
    context["reasonCode"] = json!("repeated-event");
    context
}
fn clipped(at: f64) -> f64 {
    if at.is_finite() && at.abs() <= 8.64e15 {
        at.trunc()
    } else {
        f64::NAN
    }
}
impl Emitter {
    pub fn new(system: JsString, clock: Clock, output: Output) -> Arc<Self> {
        Arc::new(Self {
            system,
            clock,
            output,
            state: Mutex::new(State::default()),
        })
    }
    fn record(
        &self,
        level: &str,
        message: &JsString,
        context: Option<&Value>,
        at: f64,
    ) -> Result<Value> {
        let at = clipped(at);
        if at.is_nan() {
            bail!("Invalid time value");
        }
        let timestamp = crate::wire::date_iso_milliseconds(at as i64)
            .ok_or_else(|| anyhow::anyhow!("Invalid time value"))?;
        let mut record = json!({"timestamp":timestamp,"system":log_sanitize::text(&self.system),"level":level,"message":log_sanitize::text(message)});
        if let Some(context) = context {
            record["context"] = log_sanitize::context(context);
        }
        Ok(record)
    }
    fn emit(&self, records: Vec<Value>) {
        for record in records {
            (self.output)(record);
        }
    }
    fn summary(&self, state: &mut Repeated, at: f64) -> Result<Option<Value>> {
        if state.suppressed <= 0.0 {
            return Ok(None);
        }
        let suffix = format!(
            " (repeated {} additional {})",
            Value::Number(state.suppressed).stringify(),
            if state.suppressed == 1.0 {
                "time"
            } else {
                "times"
            }
        );
        let mut units = state.message.units().to_vec();
        units.extend(suffix.encode_utf16());
        let record = self.record(
            &state.level,
            &JsString::new(units),
            Some(&repeated_context(state.context.as_ref(), state.suppressed)),
            at,
        )?;
        state.suppressed = 0.0;
        Ok(Some(record))
    }
    pub fn event(&self, level: &str, message: &JsString, context: Option<&Value>) -> Result<()> {
        (self.output)(self.record(level, message, context, (self.clock)())?);
        Ok(())
    }
    pub fn sampled(
        &self,
        key: JsString,
        every: Option<&Value>,
        level: &str,
        message: &JsString,
        context: Option<&Value>,
    ) -> Result<bool> {
        let interval = positive(every, 1.0)?;
        let emit = {
            let mut state = self.state.lock().unwrap();
            let count = state.samples.get(&key).copied().unwrap_or(0.0) + 1.0;
            bounded(&mut state.samples, key, count);
            (count - 1.0) % interval == 0.0
        };
        if emit {
            self.event(level, message, context)?;
        }
        Ok(emit)
    }
    pub fn rate_limited(
        &self,
        key: JsString,
        level: &str,
        message: &JsString,
        context: Option<&Value>,
        options: Option<&Value>,
    ) -> Result<()> {
        let at = clipped((self.clock)());
        if options == Some(&Value::Null) {
            bail!("Cannot read properties of null (reading 'windowMs')");
        }
        let window = positive(options.and_then(|v| v.get("windowMs")), 30_000.0)?;
        let every = positive(options.and_then(|v| v.get("summaryEvery")), 25.0)?;
        let mut records = Vec::new();
        {
            let mut state = self.state.lock().unwrap();
            let reset = state.repeated.get(&key).is_none_or(|old| {
                old.level != level || old.message != *message || at - old.first >= window
            });
            if reset {
                if let Some(old) = state.repeated.get_mut(&key)
                    && let Some(record) = self.summary(old, at)?
                {
                    records.push(record);
                }
                records.push(self.record(level, message, context, at)?);
                bounded(
                    &mut state.repeated,
                    key,
                    Repeated {
                        context: context.cloned(),
                        first: at,
                        last: at,
                        level: level.into(),
                        message: message.clone(),
                        suppressed: 0.0,
                    },
                );
            } else {
                let old = state.repeated.get_mut(&key).unwrap();
                old.context = context.cloned();
                old.last = at;
                old.suppressed += 1.0;
                if old.suppressed >= every {
                    if let Some(record) = self.summary(old, (self.clock)())? {
                        records.push(record);
                    }
                    old.first = at;
                }
            }
        }
        self.emit(records);
        Ok(())
    }
    pub fn flush_repeated(&self, key: Option<&JsString>) -> Result<()> {
        let mut records = Vec::new();
        {
            let mut state = self.state.lock().unwrap();
            if let Some(key) = key {
                if let Some(value) = state.repeated.get_mut(key)
                    && let Some(record) = self.summary(value, (self.clock)())?
                {
                    records.push(record);
                }
            } else {
                for value in state.repeated.values_mut() {
                    if let Some(record) = self.summary(value, (self.clock)())? {
                        records.push(record);
                    }
                }
            }
        }
        self.emit(records);
        Ok(())
    }
    pub fn dispatch(&self, call: LogCall) -> Result<()> {
        let message = JsString::from(call.message);
        match call.policy {
            Policy::Event => self.event(call.level, &message, Some(&call.context)),
            Policy::Sampled { key, every } => self
                .sampled(key, Some(&every), call.level, &message, Some(&call.context))
                .map(|_| ()),
            Policy::Repeated { key, options } => self.rate_limited(
                key,
                call.level,
                &message,
                Some(&call.context),
                options.as_ref(),
            ),
        }
    }
}
pub fn server() -> &'static Arc<Emitter> {
    static LOGGER: OnceLock<Arc<Emitter>> = OnceLock::new();
    LOGGER.get_or_init(|| {
        Emitter::new(
            "server".into(),
            Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
            Arc::new(|record| eprintln!("{}", record.stringify())),
        )
    })
}
pub fn server_logger() -> Logger {
    Arc::new(|call| {
        server()
            .dispatch(call)
            .expect("valid server operational record")
    })
}
pub fn error_details(error: &anyhow::Error) -> Value {
    use crate::workers::command_bus::CommandFailure;
    let bridge = match error.downcast_ref::<CommandFailure>() {
        Some(CommandFailure::Bridge(error)) => Some(error),
        _ => error.downcast_ref::<crate::workers::bridge::CommandError>(),
    };
    let name = if bridge.is_some_and(|error| error.encoding_error.is_some()) {
        "ZodError"
    } else {
        "Error"
    };
    let mut raw = json!({"name":name,"message":crate::settings::operation_error_message(error)});
    if let Some(code) = bridge.and_then(|error| error.code.as_ref()) {
        raw["code"] = json!(code);
    }
    super::log_sanitize::error(Some(&raw))
}
