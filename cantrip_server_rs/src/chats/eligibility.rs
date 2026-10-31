//! Model/account admission before reasoning and exact root/child pairing.
use crate::{
    operations::logging::{self, LogCall},
    wire::{Value, coercion::truthy, value::json},
};

pub fn account_provider(kind: &Value) -> bool {
    kind == "chatgpt" || kind == "grok"
}
pub fn use_chatgpt_credits(credits: &Value) -> bool {
    if !truthy(credits.get("hasCredits")) {
        return false;
    }
    if truthy(credits.get("unlimited")) {
        return true;
    }
    let Some(balance) = credits["balance"].as_js_string() else {
        return false;
    };
    let balance = balance.trim();
    let Some(balance) = balance.as_str() else {
        return false;
    };
    let mut parts = balance.split('.');
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    if !parts.next().is_some_and(digits)
        || parts.next().is_some_and(|part| !digits(part))
        || parts.next().is_some()
    {
        return false;
    }
    balance
        .parse::<f64>()
        .is_ok_and(|amount| amount.is_finite() && amount > 100.0)
}
fn display(value: &Value) -> String {
    crate::wire::coercion::string(value)
        .expect("Database model/account primitive")
        .lossy()
        .into_owned()
}
pub fn route_availability(runtime: &Value, availability: &[Value], worker: &str) -> Value {
    route_availability_for_worker(runtime, availability, &json!(worker))
}
pub fn route_availability_for_worker(
    runtime: &Value,
    availability: &[Value],
    worker: &Value,
) -> Value {
    let provider = &runtime["provider"];
    let model = &runtime["model"];
    let reason = if model.get("providerModelId") == Some(&Value::Null)
        || account_provider(&provider["kind"])
    {
        None
    } else if provider["kind"] == "ollama" {
        (!availability
            .iter()
            .find(|entry| entry.get("workerId") == Some(worker))
            .is_some_and(|entry| entry["state"] == "available"))
        .then(|| {
            format!(
                "{} is not available on this worker",
                display(&model["name"])
            )
        })
    } else if provider["kind"] == "openai-compatible"
        && provider["baseUrl"]
            .as_str()
            .and_then(|base| url::Url::parse(base).ok())
            .is_some_and(|url| url.host_str() == Some("openrouter.ai"))
    {
        (!availability
            .iter()
            .find(|entry| entry["scopeKey"] == "openrouter:global")
            .is_some_and(|entry| entry["state"] == "available"))
        .then(|| {
            format!(
                "{} is not available to this OpenRouter account",
                display(&model["name"])
            )
        })
    } else {
        None
    };
    json!({"available":reason.is_none(),"reason":reason})
}
pub fn account_routes(runtime: &Value, accounts: &[Value], preferred: Option<&Value>) -> Value {
    account_selection(runtime, accounts, preferred, None).0
}
pub(super) fn account_routes_logged(
    runtime: &Value,
    accounts: &[Value],
    preferred: Option<&Value>,
    worker: &Value,
) -> (Value, Option<LogCall>) {
    account_selection(runtime, accounts, preferred, Some(worker))
}
fn account_selection(
    runtime: &Value,
    accounts: &[Value],
    preferred: Option<&Value>,
    worker: Option<&Value>,
) -> (Value, Option<LogCall>) {
    let provider = &runtime["provider"];
    if !account_provider(&provider["kind"]) {
        return (
            json!({"runtimes":[runtime],"unavailable":Vec::<Value>::new()}),
            None,
        );
    }
    let mut ordered: Vec<_> = accounts
        .iter()
        .filter(|account| {
            truthy(account.get("enabled"))
                && (runtime["model"].get("providerModelId") == Some(&Value::Null)
                    || account["modelAvailability"] == "available")
        })
        .collect();
    ordered.sort_by(|a, b| {
        let a_preferred = a.get("accountId") == preferred;
        let b_preferred = b.get("accountId") == preferred;
        b_preferred.cmp(&a_preferred).then_with(|| {
            a["position"]
                .as_f64()
                .unwrap_or(f64::NAN)
                .partial_cmp(&b["position"].as_f64().unwrap_or(f64::NAN))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let name = display(&provider["name"]);
    if ordered.is_empty() {
        let enabled = accounts.iter().any(|a| truthy(a.get("enabled")));
        let reason = if enabled {
            format!(
                "{} is not available to any {name} account",
                display(&runtime["model"]["name"])
            )
        } else {
            format!("{name} has no enabled accounts")
        };
        let diagnostic=worker.map(|worker|LogCall::repeated(logging::key("provider-account-route-unavailable:",&[&provider["id"],worker]),"warn","Account provider has no routable accounts",json!({"event":"provider.account_route.unavailable","subsystem":"provider-routing","operation":"resolve-account-route","status":"unavailable","reasonCode":if enabled{"model_unavailable"}else{"no_enabled_accounts"},"providerId":provider["id"],"workerId":worker,"counts":json!({"accounts":accounts.len()})}),Some(json!({"summaryEvery":10,"windowMs":60_000}))));
        return (
            json!({"runtimes":Vec::<Value>::new(),"unavailable":[reason]}),
            diagnostic,
        );
    }
    let (mut healthy, mut legacy, mut unavailable) = (Vec::new(), Vec::new(), Vec::new());
    let (mut migration_needed, mut requires_sign_in, mut below_reserve, mut exhausted) =
        (0, 0, 0, 0);
    for account in ordered {
        let id = display(&account["accountId"]);
        if account["credentialState"] == "migration-needed" {
            if truthy(account.get("legacyWorkerAuthenticated")) {
                legacy.push(account);
            } else {
                migration_needed += 1;
                unavailable.push(format!(
                    "{name} account {id} must be migrated; reconnect its original worker"
                ));
            }
        } else if account["credentialState"] != "signed-in" {
            requires_sign_in += 1;
            unavailable.push(if account["credentialState"] == "conflict" {
                format!("{name} account {id} has a credential identity conflict")
            } else {
                format!("{name} account {id} requires sign-in")
            });
        } else {
            let remaining = account["weeklyUsageUsedPercent"]
                .as_f64()
                .map(|used| (100.0 - used).max(0.0));
            if (provider["kind"] == "chatgpt" && use_chatgpt_credits(&account["credits"]))
                || remaining.is_none()
                || remaining.is_some_and(|value| {
                    value
                        > provider["weeklyUsageReservePercent"]
                            .as_f64()
                            .unwrap_or(f64::NAN)
                })
            {
                healthy.push(account);
            } else if remaining.is_some_and(|value| value > 0.0) {
                below_reserve += 1;
                unavailable.push(format!(
                    "{name} account {id} is below its {}% weekly usage reserve",
                    display(&provider["weeklyUsageReservePercent"])
                ));
            } else {
                exhausted += 1;
                unavailable.push(format!("{name} account {id} has no weekly usage left"));
            }
        }
    }
    let diagnostic=worker.map(|worker|LogCall::sampled(logging::key("provider-account-route:",&[&provider["id"],worker]),20,"debug","Account provider routes resolved",json!({"event":"provider.account_route.resolved","subsystem":"provider-routing","operation":"resolve-account-route","status":if healthy.len()+legacy.len()>0{"completed"}else{"unavailable"},"providerId":provider["id"],"workerId":worker,"counts":json!({"accounts":accounts.len(),"healthy":healthy.len(),"legacy":legacy.len(),"migrationNeeded":migration_needed,"requiresSignIn":requires_sign_in,"belowReserve":below_reserve,"exhausted":exhausted})})));
    let runtimes: Vec<_> = healthy
        .into_iter()
        .chain(legacy)
        .map(|account| {
            let mut runtime = runtime.clone();
            for key in ["accountId", "credentialHomeKey", "credits"] {
                runtime["provider"][key] = account[key].clone();
            }
            runtime
        })
        .collect();
    (
        json!({"runtimes":runtimes,"unavailable":unavailable}),
        diagnostic,
    )
}
