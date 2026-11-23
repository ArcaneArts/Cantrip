//! The protocol's interaction ownership and durable-state refinements.
use super::{Parsed, ValidationError, Value, coercion::truthy, value::json};

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !tag.starts_with("interaction-") {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut custom = |suffix: &[&str], message: &str| {
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|key| json!(key)));
        result
            .issues
            .push(json!({"code":"custom","path":at,"message":message}));
    };
    let computer = value["provenance"]["owner"] == "computer-use";
    if computer && value.get("id").is_some() && !super::worker_contract::uuid(&value["id"]) {
        custom(
            &["id"],
            "Computer-use interaction IDs must be genuine request UUIDs.",
        );
    }
    let protected = tag == "interaction-protected-row";
    if protected {
        if computer && value["classification"]["kind"] != "permissions" {
            custom(
                &["classification", "kind"],
                "Computer-use interactions require permissions classification.",
            );
        }
    } else {
        let native = value["payload"]["kind"] == "permissions"
            && value["payload"]["source"] == "native-computer-use";
        if computer != native {
            custom(
                &["payload"],
                "Native computer-use permissions require computer-use provenance, and no other payload kind may use that owner.",
            );
        }
    }
    if tag == "interaction-payload-owner" {
        return Ok(true);
    }
    if tag != "interaction-visible-row" && !protected {
        return Err(ValidationError::Operation);
    }
    let response = if protected {
        "protectedResponse"
    } else {
        "response"
    };
    let response_present = truthy(value.get(response));
    if !protected && response_present && value["response"]["kind"] != value["payload"]["kind"] {
        custom(
            &["response", "kind"],
            "Response kind must match request kind.",
        );
    }
    let user = truthy(value.get("resolvedByUserId"));
    let time = truthy(value.get("resolvedAt"));
    if value["status"] == "pending" {
        if response_present || user || time {
            custom(
                &["status"],
                "Pending requests cannot contain resolution data.",
            );
        }
    } else if value["status"] == "resolved" {
        if !response_present || !user || !time {
            custom(
                &["status"],
                if protected {
                    "Resolved requests require protected resolution data."
                } else {
                    "Resolved requests require response and resolution data."
                },
            );
        }
    } else if response_present || user || !time {
        custom(
            &["status"],
            "Expired and interrupted requests require a terminal timestamp without a response.",
        );
    }
    Ok(true)
}
