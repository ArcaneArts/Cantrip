use std::{collections::BTreeMap, time::Duration};

use anyhow::{Context, Result};
use postgres_native_tls::MakeTlsConnector;
use tokio_postgres::{Config, config::SslMode};

pub(super) fn parse(value: &str) -> Result<(Config, MakeTlsConnector)> {
    let mut url = url::Url::parse(value).context("parse PostgreSQL URL")?;
    let options: BTreeMap<_, _> = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    // postgres-js resolves sslmode before ssl, using the last occurrence of each
    // key. Its omitted SSL option is false; tokio-postgres defaults to Prefer.
    let query_ssl = options
        .get("sslmode")
        .filter(|value| !value.is_empty())
        .or_else(|| options.get("ssl"));
    let environment_ssl = std::env::var("PGSSL")
        .ok()
        .filter(|value| !value.is_empty());
    let selected = query_ssl.or(environment_ssl.as_ref());
    let (mode, verify) = match selected.map(String::as_str) {
        None | Some("") => (SslMode::Disable, true),
        Some("disable" | "false") if query_ssl.is_some() => (SslMode::Disable, true),
        Some("prefer") => (SslMode::Prefer, false),
        Some("allow" | "require") => (SslMode::Require, false),
        // postgres-js performs normal certificate/hostname verification for
        // verify-full, verify-ca and other truthy SSL values. Preserve that
        // behavior rather than treating encryption as certificate validation.
        Some(_) => (SslMode::Require, true),
    };
    // The policy above also resolves an empty sslmode. Do not pass that empty
    // value to tokio-postgres, which rejects a Node-accepted connection.
    let retained: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key != "ssl" && key != "sslmode")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    url.set_query(None);
    if !retained.is_empty() {
        // URLSearchParams decodes '+' as a space; tokio-postgres's URI decoder
        // only percent-decodes. Re-encode decoded values with %20, otherwise
        // accepted startup options such as '-c role=...' reach PostgreSQL as
        // '-c+role=...' and fail with an unrecognized '+role' setting.
        let escape = |value: &str| {
            percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC)
                .to_string()
        };
        let query = retained
            .iter()
            .map(|(key, value)| format!("{}={}", escape(key), escape(value)))
            .collect::<Vec<_>>()
            .join("&");
        url.set_query(Some(&query));
    }
    let mut configuration: Config = url
        .as_str()
        .parse()
        .context("parse PostgreSQL connection options")?;
    configuration
        .ssl_mode(mode)
        .connect_timeout(Duration::from_secs(2));
    let mut tls = native_tls::TlsConnector::builder();
    if !verify {
        tls.danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }
    Ok((configuration, MakeTlsConnector::new(tls.build()?)))
}
