use super::*;
use crate::grok::http::{CLIENT_ID as GROK_CLIENT, TOKEN_URL as GROK_ENDPOINT};
use base64::{
    Engine, alphabet,
    engine::general_purpose::{GeneralPurpose, NO_PAD},
};

const CHATGPT_CLIENT: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_ENDPOINT: &str = "https://auth.openai.com/oauth/token";

pub(super) async fn refresh(client: &reqwest::Client, current: &Value) -> Result<Value> {
    let token = nonempty(&current["refreshToken"])
        .and_then(JsString::as_str)
        .ok_or_else(|| lease_error(409, Some("reauth-required")))?;
    let chatgpt = current["kind"] == "chatgpt";
    let request = if chatgpt {
        client.post(CHATGPT_ENDPOINT).header("content-type", "application/json")
            .body(json!({"client_id":CHATGPT_CLIENT,"grant_type":"refresh_token","refresh_token":token}).stringify())
    } else {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", GROK_CLIENT)
            .append_pair("grant_type", "refresh_token")
            .append_pair("refresh_token", token)
            .finish();
        client
            .post(GROK_ENDPOINT)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
    };
    let response = request
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|_| refresh_failed())?;
    let status = response.status().as_u16();
    let payload = json_body(response).await.map_err(|_| refresh_failed())?;
    if !payload.is_object() {
        return Err(refresh_failed());
    }
    if !(200..300).contains(&status) {
        let invalid = payload["error"]
            .as_str()
            .is_some_and(|v| v.eq_ignore_ascii_case("invalid_grant"));
        return Err(if status == 401 || invalid {
            lease_error(409, Some("reauth-required"))
        } else {
            refresh_failed()
        });
    }
    refreshed(current, &payload, chrono::Utc::now().timestamp_millis())
}

pub(super) fn refreshed(current: &Value, payload: &Value, now: i64) -> Result<Value> {
    let mut credential = current.clone();
    let access_token = nonempty(&payload["access_token"]).ok_or_else(refresh_failed)?;
    let token_claims = claims(Some(access_token));
    let expiry = token_claims["exp"]
        .as_i64()
        .filter(|exp| (1..=9_007_199_254_740_991).contains(exp))
        .map(|exp| exp as f64 * 1000.0)
        .or_else(|| {
            payload["expires_in"]
                .as_f64()
                .filter(|exp| *exp > 0.0)
                .map(|exp| now as f64 + exp * 1000.0)
        });
    if current["kind"] == "chatgpt" {
        let id_token = nonempty(&payload["id_token"]).or_else(|| current["idToken"].as_js_string());
        let id_claims = claims(id_token);
        let auth = &token_claims["https://api.openai.com/auth"];
        let id_auth = &id_claims["https://api.openai.com/auth"];
        let account = nonempty(&auth["chatgpt_account_id"])
            .or_else(|| nonempty(&id_auth["chatgpt_account_id"]));
        let user =
            nonempty(&auth["chatgpt_user_id"]).or_else(|| nonempty(&id_auth["chatgpt_user_id"]));
        if account.is_some_and(|account| current["accountId"].as_js_string() != Some(account))
            || user.is_some_and(|user| {
                nonempty(&current["userId"]).is_some_and(|previous| previous != user)
            })
        {
            return Err(lease_error(409, Some("identity-conflict")));
        }
        credential["idToken"] = json!(id_token);
        credential["userId"] = user.map_or_else(|| current["userId"].clone(), |user| json!(user));
        credential["expiresAt"] = json!(expiry);
    } else {
        let identity = claims(nonempty(&payload["id_token"]));
        let user = nonempty(&identity["sub"]);
        if user.is_some_and(|user| current["userId"].as_js_string() != Some(user)) {
            return Err(lease_error(409, Some("identity-conflict")));
        }
        credential["email"] = nonempty(&identity["email"])
            .map_or_else(|| current["email"].clone(), |email| json!(email));
        credential["expiresAt"] =
            expiry.map_or_else(|| current["expiresAt"].clone(), |time| json!(time));
    }
    credential["accessToken"] = json!(access_token);
    if let Some(token) = nonempty(&payload["refresh_token"]) {
        credential["refreshToken"] = json!(token);
    }
    Ok(credential)
}

pub(crate) fn claims(token: Option<&JsString>) -> Value {
    const DECODER: GeneralPurpose = GeneralPurpose::new(
        &alphabet::URL_SAFE,
        NO_PAD.with_decode_allow_trailing_bits(true),
    );
    let token = token.map(JsString::lossy);
    let payload = token.as_ref().and_then(|token| token.split('.').nth(1));
    // The legacy reader uses Buffer.from(base64url), which also accepts
    // standard base64 characters and ignores bytes outside either alphabet.
    payload
        .and_then(|payload| {
            let mut bytes = payload
                .bytes()
                .take_while(|byte| *byte != b'=')
                .filter_map(|byte| match byte {
                    b'+' => Some(b'-'),
                    b'/' => Some(b'_'),
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' => Some(byte),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if bytes.len() % 4 == 1 {
                bytes.pop();
            }
            DECODER.decode(bytes).ok()
        })
        .and_then(|data| parse_json_text(&String::from_utf8_lossy(&data)).ok())
        .filter(Value::is_object)
        .unwrap_or(Value::Null)
}

fn refresh_failed() -> anyhow::Error {
    lease_error(409, Some("refresh-failed"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    fn token(claims: Value) -> String {
        format!(
            "fixture.{}.fixture",
            URL_SAFE_NO_PAD.encode(claims.stringify())
        )
    }

    #[test]
    fn chatgpt_rotations_keep_the_account_and_reject_conflicting_identity() {
        let current = json!({
            "kind":"chatgpt","accountId":"account","userId":Value::Null,
            "refreshToken":"previous-refresh","idToken":Value::Null,"expiresAt":Value::Null
        });
        let claims = json!({"exp":2_000_000_000,"https://api.openai.com/auth":json!({"chatgpt_account_id":"account","chatgpt_user_id":"user"})});
        let mut payload =
            json!({"access_token":token(claims), "refresh_token":"replacement-refresh"});
        let updated = refreshed(&current, &payload, 0).unwrap();
        assert_eq!(updated["expiresAt"], json!(2_000_000_000_000_i64));
        assert_eq!(updated["userId"], "user");
        assert_eq!(updated["refreshToken"], "replacement-refresh");
        payload["access_token"] = json!(token(
            json!({"https://api.openai.com/auth":json!({"chatgpt_account_id":"another"})})
        ));
        let refusal = refreshed(&current, &payload, 0).unwrap_err();
        assert_eq!(
            refusal.downcast_ref::<RequestError>().unwrap().code,
            Some("identity-conflict")
        );
    }

    #[test]
    fn grok_supports_oauth_expiry_fallback_and_retains_canonical_user() {
        let current = json!({"kind":"grok","userId":"user","email":Value::Null,"expiresAt":123,"refreshToken":"existing"});
        let mut payload = json!({"access_token":"opaque","id_token":token(json!({"sub":"user","email":"synthetic@example.invalid"})),"expires_in":30});
        let updated = refreshed(&current, &payload, 1000).unwrap();
        assert_eq!(updated["expiresAt"], json!(31_000));
        assert_eq!(updated["email"], "synthetic@example.invalid");
        assert_eq!(updated["refreshToken"], "existing");
        payload["id_token"] = json!(token(json!({"sub":"another"})));
        let refusal = refreshed(&current, &payload, 0).unwrap_err();
        assert_eq!(
            refusal.downcast_ref::<RequestError>().unwrap().code,
            Some("identity-conflict")
        );
    }
}
