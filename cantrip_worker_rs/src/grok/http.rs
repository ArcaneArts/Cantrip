use crate::{http::checked, provider_access::json_body};
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{Value, value::json};
use reqwest::{Response, StatusCode};
use std::time::Duration;
use tokio::time::Instant;
use url::Url;

pub const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
pub const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const DEVICE_URL: &str = "https://auth.x.ai/oauth2/device/code";
const SUBSCRIPTION: &str = "https://cli-chat-proxy.grok.com/v1/";
const SCOPES: &str = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";
const DEADLINE: Duration = Duration::from_secs(9);

#[derive(Clone)]
pub(super) struct Http {
    client: reqwest::Client,
    device: Url,
    token: Url,
    subscription: Url,
    version: String,
}

pub(super) struct Device {
    secret: String,
    interval: Duration,
    expires: Instant,
    pub reply: Value,
}

impl Http {
    pub(super) fn new(version: String) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(DEADLINE)
                .build()?,
            device: Url::parse(DEVICE_URL)?,
            token: Url::parse(TOKEN_URL)?,
            subscription: Url::parse(SUBSCRIPTION)?,
            version,
        })
    }

    #[cfg(test)]
    pub(super) fn fixture(mut self, base: Url) -> Self {
        self.device = base.join("oauth2/device/code").unwrap();
        self.token = base.join("oauth2/token").unwrap();
        self.subscription = base.join("v1/").unwrap();
        self
    }

    pub(super) async fn start(&self, id: &str) -> Result<Device> {
        let (status, value) = self
            .oauth(
                self.device.clone(),
                &[
                    ("client_id", CLIENT_ID),
                    ("scope", SCOPES),
                    ("referrer", "grok-build"),
                ],
                true,
            )
            .await?;
        if !status.is_success() {
            bail!("Grok device sign-in could not start ({}).", status.as_u16());
        }
        let invalid = || anyhow!("Grok returned an invalid device-code response.");
        let secret = value["device_code"]
            .as_str()
            .filter(|code| !code.is_empty())
            .ok_or_else(invalid)?;
        let expires = value["expires_in"]
            .as_f64()
            .and_then(duration)
            .and_then(|age| Instant::now().checked_add(age))
            .ok_or_else(invalid)?;
        let interval = duration(value["interval"].as_f64().unwrap_or(5.0)).ok_or_else(invalid)?;
        let user_code = value["user_code"]
            .as_str()
            .filter(|code| !code.is_empty())
            .ok_or_else(invalid)?;
        if !user_code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            bail!("Grok returned an invalid device sign-in code.");
        }
        let uri = value["verification_uri"]
            .as_str()
            .filter(|uri| !uri.is_empty())
            .ok_or_else(invalid)?;
        let complete = value["verification_uri_complete"].as_str();
        for uri in [Some(uri), complete].into_iter().flatten() {
            let parsed = Url::parse(uri)
                .map_err(|_| anyhow!("Grok returned an unsupported verification URL."))?;
            if parsed.scheme() != "https"
                && !(parsed.scheme() == "http"
                    && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")))
            {
                bail!("Grok returned an unsupported verification URL.");
            }
        }
        let reply = checked(
            "codexDeviceLoginSchema",
            &json!({
                "loginId":id,"userCode":user_code,"verificationUrl":complete.unwrap_or(uri)
            }),
        )?;
        Ok(Device {
            secret: secret.to_owned(),
            interval,
            expires,
            reply,
        })
    }

    pub(super) async fn poll(&self, device: Device) -> Result<Value> {
        let mut interval = device.interval;
        loop {
            if tokio::time::timeout_at(device.expires, tokio::time::sleep(interval))
                .await
                .is_err()
            {
                bail!("The Grok sign-in code expired.");
            }
            let fields = [
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ("device_code", device.secret.as_str()),
                ("client_id", CLIENT_ID),
            ];
            let exchange = self.oauth(self.token.clone(), &fields, true);
            let (status, value) = tokio::time::timeout_at(device.expires, exchange)
                .await
                .map_err(|_| anyhow!("The Grok sign-in code expired."))??;
            if status.is_success() && access_token(&value).is_some() {
                return Ok(value);
            }
            match value["error"].as_str() {
                Some("authorization_pending") => {}
                Some("slow_down") => interval = interval.saturating_add(Duration::from_secs(5)),
                Some("access_denied") => bail!("Grok sign-in was denied."),
                Some("expired_token") => bail!("The Grok sign-in code expired."),
                _ => bail!("Grok sign-in failed."),
            }
        }
    }

    pub(super) async fn refresh(&self, token: &str) -> Result<(StatusCode, Value)> {
        self.oauth(
            self.token.clone(),
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", token),
                ("client_id", CLIENT_ID),
            ],
            false,
        )
        .await
    }

    async fn oauth(
        &self,
        url: Url,
        fields: &[(&str, &str)],
        device: bool,
    ) -> Result<(StatusCode, Value)> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields.iter().copied())
            .finish();
        let mut request = self
            .client
            .post(url)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body);
        if device {
            request = request
                .header("x-grok-client-surface", "ui")
                .header("x-grok-client-version", &self.version);
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow!("Grok authorization request failed."))?;
        let status = response.status();
        let value = json_body(response)
            .await
            .map_err(|_| anyhow!("Grok authorization returned an invalid response."))?;
        Ok((status, value))
    }

    pub(super) async fn subscription(
        &self,
        resource: &str,
        credential: &Value,
    ) -> Result<Response> {
        let target = self.subscription.join(resource)?;
        if target.origin() != self.subscription.origin() {
            bail!("Grok credential forwarding escaped the subscription proxy.");
        }
        let mut request = self
            .client
            .get(target)
            .bearer_auth(
                credential["accessToken"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Grok access token is invalid."))?,
            )
            .header("x-xai-token-auth", "xai-grok-cli")
            .header("x-grok-client-version", &self.version)
            .header("x-grok-client-identifier", "cantrip")
            .header("x-grok-client-mode", "interactive")
            .header("x-authenticateresponse", "authenticate-response");
        if let Some(id) = credential["userId"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            request = request.header("x-userid", id).header("x-grok-user-id", id);
        }
        if let Some(email) = credential["email"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            request = request.header("x-email", email);
        }
        request
            .send()
            .await
            .map_err(|_| anyhow!("Grok subscription request failed."))
    }
}

fn duration(seconds: f64) -> Option<Duration> {
    seconds
        .is_finite()
        .then(|| Duration::try_from_secs_f64(seconds.max(1.0)).ok())
        .flatten()
}

pub(super) fn access_token(payload: &Value) -> Option<&str> {
    payload["access_token"]
        .as_str()
        .filter(|value| !value.is_empty())
}

pub(super) fn weekly_usage(body: &Value) -> Value {
    let config = &body["config"];
    let period = &config["currentPeriod"];
    if period["type"] != "USAGE_PERIOD_TYPE_WEEKLY" {
        return Value::Null;
    }
    let used = if config["creditUsagePercent"].is_null() {
        Some(0.0)
    } else {
        config["creditUsagePercent"].as_f64()
    };
    let Some(used) = used.filter(|value| (0.0..=100.0).contains(value)) else {
        return Value::Null;
    };
    let resets = period["end"]
        .as_js_string()
        .and_then(cantrip_wire::date::parse)
        .map(|millis| millis.div_euclid(1000));
    json!({"usedPercent":used,"resetsAt":resets})
}
