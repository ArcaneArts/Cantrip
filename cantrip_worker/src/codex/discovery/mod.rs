mod probe;
use crate::native_items::s;
use anyhow::Result;
use cantrip_wire::{JsString, Value, coercion, value::json};
pub use probe::{Options, discover, version};
use regress::Regex;
use std::sync::LazyLock;
pub const TESTED_RANGE: &str = ">=0.166.0 <0.167.0";
pub const CORE: &[&str] = &[
    "initialize",
    "thread/start",
    "thread/resume",
    "thread/list",
    "thread/read",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
];
pub const OPTIONAL: &[&str] = &[
    "account/login/start",
    "thread/compact/start",
    "model/list",
    "experimentalFeature/list",
    "permissionProfile/list",
    "app/list",
    "collaborationMode/list",
    "thread/goal/get",
    "thread/goal/set",
    "thread/goal/clear",
    "hooks/list",
    "skills/list",
    "skills/config/write",
    "skills/extraRoots/set",
    "mcpServerStatus/list",
    "mcpServer/oauth/login",
    "mcpServer/resource/read",
    "config/mcpServer/reload",
    "plugin/list",
    "plugin/read",
    "plugin/install",
    "plugin/uninstall",
    "externalAgentConfig/detect",
    "externalAgentConfig/import",
    "externalAgentConfig/import/readHistories",
    "externalAgentConfig/import/recordHistory",
    "config/read",
    "server/diagnostics",
    "thread/inject_items",
    "thread/unsubscribe",
    "thread/settings/update",
    "thread/queue/add",
    "thread/queue/list",
    "thread/queue/update",
    "thread/queue/delete",
    "thread/queue/reorder",
    "thread/queue/start",
    "thread/revert",
];
pub fn methods() -> impl Iterator<Item = &'static str> {
    CORE.iter().chain(OPTIONAL).copied()
}
pub fn semantic(raw: &JsString) -> Option<JsString> {
    static VERSION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::with_flags(r"(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)", "u").unwrap()
    });
    let raw = raw.trim();
    let found = VERSION.find_from_utf16(raw.units(), 0).next()?;
    let mut result = Vec::new();
    for index in 1..=3 {
        if index > 1 {
            result.push(46);
        }
        result.extend_from_slice(&raw.units()[found.group(index)?]);
    }
    Some(JsString::new(result))
}
pub fn tested(semantic: &JsString) -> bool {
    let parts = semantic
        .units()
        .split(|u| *u == 46)
        .map(|v| coercion::number(Some(&s(JsString::new(v.to_vec())))).unwrap_or(f64::NAN))
        .collect::<Vec<_>>();
    parts.len() == 3
        && parts[0] == 0.
        && parts[1] == 166.
        && parts[2].is_finite()
        && parts[2].fract() == 0.
        && parts[2] >= 0.
}
pub fn initialize(value: &Value, experimental: bool) -> Option<Value> {
    if !value.is_object()
        || ["userAgent", "platformFamily", "platformOs"]
            .iter()
            .any(|key| value[*key].as_js_string().is_none_or(|v| v.is_empty()))
    {
        return None;
    }
    Some(
        json!({"userAgent":value["userAgent"],"platformFamily":value["platformFamily"],"platformOs":value["platformOs"],"experimentalApi":experimental}),
    )
}
pub fn feature_page(value: &Value) -> Option<Value> {
    if !value.is_object()
        || !(value["nextCursor"].is_null() && value.get("nextCursor").is_some()
            || value["nextCursor"].is_string())
    {
        return None;
    }
    let mut features = Vec::new();
    for feature in value["data"].as_array()? {
        if !feature.is_object()
            || feature["name"].as_js_string().is_none_or(|v| v.is_empty())
            || !matches!(
                feature["stage"].as_str(),
                Some("beta" | "underDevelopment" | "stable" | "deprecated" | "removed")
            )
            || !feature["enabled"].is_boolean()
            || !feature["defaultEnabled"].is_boolean()
        {
            return None;
        }
        features.push(json!({"name":feature["name"],"stage":feature["stage"],"enabled":feature["enabled"],"defaultEnabled":feature["defaultEnabled"]}));
    }
    Some(json!({"data":features,"nextCursor":value["nextCursor"]}))
}
pub fn subagents(compatible: bool, features: &[Value]) -> Value {
    let available = compatible
        && features
            .iter()
            .any(|v| v["name"] == "multi_agent" && v["stage"] == "stable");
    json!({"available":available,"protocolVersion":if available {json!(1)}else{Value::Null},"reason":if available {Value::Null}else{s(if compatible {"The installed Codex runtime does not advertise stable native multi-agent support."}else{"The installed Codex runtime is not compatible with native subagents."})}})
}
pub fn methods_available(report: &Value, methods: &[Value]) -> bool {
    methods.iter().all(|method| {
        report["methods"]
            .get(method.as_str().unwrap_or(""))
            .is_some_and(|v| v == "available")
    })
}
pub fn feature_usable(report: &Value, name: &Value) -> bool {
    report["features"]
        .as_array()
        .and_then(|features| features.iter().find(|v| v["name"] == *name))
        .is_some_and(|v| {
            coercion::truthy(v.get("enabled"))
                && v["stage"] != "deprecated"
                && v["stage"] != "removed"
        })
}
pub fn assess(input: &Value) -> Result<Value> {
    if !coercion::truthy(input.get("versionRaw")) {
        return report(
            &json!({"adapter":"app-server","compatibility":"missing","version":Value::Null,"testedRange":TESTED_RANGE,"initialize":Value::Null,"methods":json!({}),"features":Vec::<Value>::new(),"degradedReasons":vec!["The configured Codex binary was not found or did not report a version."]}),
        );
    }
    let raw = input["versionRaw"].as_js_string().unwrap();
    let parsed = semantic(raw);
    let methods = Value::object(methods().map(|method| {
        (
            method,
            input["methods"]
                .get(method)
                .cloned()
                .unwrap_or_else(|| s("unknown")),
        )
    }));
    let mut reasons = input["errors"].as_array().cloned().unwrap_or_default();
    match &parsed {
        None => reasons.insert(
            0,
            s(format!(
                "Could not parse a semantic version from {}.",
                s(raw.clone()).stringify()
            )),
        ),
        Some(version) if !tested(version) => reasons.insert(
            0,
            s(format!(
                "Codex {} is outside Cantrip's tested range {TESTED_RANGE}.",
                version.lossy()
            )),
        ),
        Some(_) => {}
    }
    let initialized = coercion::truthy(input.get("initialize"));
    if !initialized {
        reasons.push(s(
            "Codex app-server did not complete a valid initialize handshake.",
        ));
    }
    let unavailable = |list: &'static [&'static str]| {
        list.iter()
            .copied()
            .filter(|method| methods[*method] != "available")
            .collect::<Vec<_>>()
    };
    let core = unavailable(CORE);
    let optional = unavailable(OPTIONAL);
    for (label, list) in [("Required", &core), ("Optional", &optional)] {
        if !list.is_empty() {
            reasons.push(s(format!(
                "{label} App Server methods are unavailable or unverified: {}.",
                list.join(", ")
            )));
        }
    }
    let experimental = coercion::truthy(input["initialize"].get("experimentalApi"));
    if initialized && !experimental {
        reasons.push(s(
            "The runtime initialized without the experimental API capability.",
        ));
    }
    let incompatible =
        parsed.as_ref().is_none_or(|v| !tested(v)) || !initialized || !core.is_empty();
    let partial = !incompatible && (!optional.is_empty() || !experimental);
    let mut features = input["features"].as_array().cloned().unwrap_or_default();
    let locale: icu_locale_core::Locale = cantrip_wire::environment::locale()
        .unwrap_or("en-US")
        .parse()
        .unwrap_or_else(|_| "en-US".parse().unwrap());
    let collator = icu_collator::Collator::try_new(locale.into(), Default::default())
        .map_err(|error| anyhow::anyhow!("Codex feature sorting locale: {error}"))?;
    features.sort_by(|a, b| {
        collator.compare_utf16_icu4c(
            a["name"].as_js_string().unwrap().units(),
            b["name"].as_js_string().unwrap().units(),
        )
    });
    let mut unique = Vec::new();
    for reason in reasons {
        if !unique.contains(&reason) {
            unique.push(reason);
        }
    }
    report(
        &json!({"adapter":"app-server","compatibility":if incompatible {"incompatible"}else if partial {"partial"}else{"compatible"},"version":parsed.map_or(Value::Null,|semantic|json!({"raw":raw,"semantic":semantic})),"testedRange":TESTED_RANGE,"initialize":input["initialize"],"methods":methods,"features":features,"nativeSubagents":subagents(!incompatible,&features),"degradedReasons":unique}),
    )
}

fn report(value: &Value) -> Result<Value> {
    cantrip_protocol::parse_property("workerHeartbeatSchema", "codexRuntime", value)
        .map_err(cantrip_protocol::response::response_error)
}
