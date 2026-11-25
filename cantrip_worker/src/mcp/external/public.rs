//! Public MCP resource behind a trusted HTTPS reverse proxy.
use super::{HTTP_PATH, Host, USAGE, header_text, read_secret, reply, response_payload};
use anyhow::{Context, Result, ensure};
use cantrip_protocol::external_mcp::{
    OAUTH_EXCHANGE_PATH, OAUTH_RESOURCE_PATH, OAUTH_SCOPE, opaque_secret,
};
use cantrip_wire::value::json;
use http_body_util::Full;
use hyper::{HeaderMap, Method, Response, StatusCode, body::Bytes, header};
use std::{ffi::OsString, path::Path};
use url::Url;
use zeroize::Zeroizing;

pub(super) struct Endpoint {
    url: Url,
    issuer: String,
    key: Zeroizing<String>,
    challenge: header::HeaderValue,
}

pub(super) fn parse(arguments: &mut impl Iterator<Item = OsString>) -> Result<Option<Endpoint>> {
    let Some(flag) = arguments.next() else {
        return Ok(None);
    };
    ensure!(flag == "--public-url", "{USAGE}");
    let url = arguments.next().context(USAGE)?;
    let url = https_url(url.to_str().context(USAGE)?, HTTP_PATH)?;
    ensure!(
        arguments.next().is_some_and(|flag| flag == "--issuer"),
        "{USAGE}"
    );
    let issuer = arguments.next().context(USAGE)?;
    let issuer = https_url(issuer.to_str().context(USAGE)?, "/")?
        .origin()
        .ascii_serialization();
    ensure!(
        arguments
            .next()
            .is_some_and(|flag| flag == "--bridge-key-file"),
        "{USAGE}"
    );
    let path = arguments.next().context(USAGE)?;
    let key = read_secret(Path::new(&path))?;
    ensure!(
        opaque_secret(&key, "ctbk_"),
        "Invalid Cantrip MCP bridge key file."
    );
    let metadata = url.join(OAUTH_RESOURCE_PATH)?;
    let challenge =
        format!(r#"Bearer resource_metadata="{metadata}", scope="{OAUTH_SCOPE}""#).parse()?;
    Ok(Some(Endpoint {
        url,
        issuer,
        key,
        challenge,
    }))
}

fn https_url(input: &str, path: &str) -> Result<Url> {
    let url = Url::parse(input).context("Invalid external MCP HTTPS URL.")?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.port_or_known_default().is_some_and(|port| port > 0)
            && url.path() == path
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Invalid external MCP HTTPS URL."
    );
    Ok(url)
}

impl Endpoint {
    pub(super) fn valid_authority(&self, host: &str, origin: Option<&str>) -> bool {
        if !host
            .parse::<hyper::http::uri::Authority>()
            .is_ok_and(|host| {
                self.url.host_str().is_some_and(|expected| {
                    host.host().eq_ignore_ascii_case(expected)
                        && host.port_u16().unwrap_or(443)
                            == self
                                .url
                                .port_or_known_default()
                                .expect("validated HTTPS port")
                }) && !host.as_str().contains('@')
            })
        {
            return false;
        }
        origin.is_none_or(|origin| origin == self.url.origin().ascii_serialization())
    }

    pub(super) fn metadata(&self) -> Response<Full<Bytes>> {
        reply(
            StatusCode::OK,
            Some(json!({
                "resource":self.url.as_str(),
                "authorization_servers":vec![self.issuer.as_str()],
                "scopes_supported":vec![OAUTH_SCOPE],
                "bearer_methods_supported":vec!["header"],
            })),
        )
    }

    fn unauthorized(&self, invalid_token: bool) -> Response<Full<Bytes>> {
        let mut response = reply(StatusCode::UNAUTHORIZED, None);
        let challenge = if invalid_token {
            format!(
                r#"{}, error="invalid_token""#,
                self.challenge.to_str().expect("ASCII challenge")
            )
            .parse()
            .expect("valid challenge")
        } else {
            self.challenge.clone()
        };
        response
            .headers_mut()
            .insert(header::WWW_AUTHENTICATE, challenge);
        response
    }

    pub(super) async fn authorize(
        &self,
        host: &Host,
        headers: &HeaderMap,
    ) -> std::result::Result<Host, Response<Full<Bytes>>> {
        let Some(token) = header_text(headers, "authorization").and_then(|value| {
            let (scheme, token) = value.split_once(' ')?;
            (scheme.eq_ignore_ascii_case("Bearer") && opaque_secret(token, "ctoa_"))
                .then_some(token)
        }) else {
            return Err(self.unauthorized(headers.contains_key(header::AUTHORIZATION)));
        };
        let unavailable = || reply(StatusCode::SERVICE_UNAVAILABLE, None);
        let response = host
            .client
            .request(
                Method::POST,
                host.origin
                    .join(OAUTH_EXCHANGE_PATH)
                    .expect("known exchange path"),
            )
            .bearer_auth(self.key.as_str())
            .header(header::CONTENT_TYPE, "application/json")
            .body(json!({"accessToken":token,"resource":self.url.as_str()}).stringify())
            .send()
            .await
            .map_err(|_| unavailable())?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(self.unauthorized(true));
        }
        let mut payload = response_payload(response)
            .await
            .map_err(|_| unavailable())?;
        let credential = std::mem::take(&mut payload["credential"]);
        let credential = Zeroizing::new(credential.as_str().unwrap_or_default().to_owned());
        if payload["resource"] != self.url.as_str()
            || payload["issuer"] != self.issuer.as_str()
            || !opaque_secret(&credential, "ctmb_")
        {
            return Err(unavailable());
        }
        Ok(Host {
            origin: host.origin.clone(),
            client: host.client.clone(),
            credential: Some(credential),
        })
    }
}
