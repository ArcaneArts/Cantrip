//! Environment compatibility with the existing server. This type deliberately
//! has no Debug implementation: it contains credentials and encryption keys.
mod peer;
mod secret;
mod value;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fmt,
    path::{Path, PathBuf},
};
use url::Url;

pub use peer::{PeerConfig, WebRtcConfig};
pub use secret::SecretEncryption;
pub use value::Environment;
use value::{Reader, enumeration, length};

#[derive(Debug)]
pub struct ConfigError {
    pub name: &'static str,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, ConfigError>;
impl ConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            name: "Error",
            message: message.into(),
        }
    }
    fn zod(issues: Vec<Value>) -> Self {
        Self {
            name: "ZodError",
            message: serde_json::to_string_pretty(&issues).expect("JSON validation issues"),
        }
    }
}
impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ConfigError {}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeploymentMode {
    Local,
    Hosted,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    None,
    Password,
    Accounts,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BootstrapMode {
    #[serde(rename = "pnpm-dev")]
    PnpmDev,
    Tauri,
    Standalone,
    Hosted,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SameSite {
    Lax,
    None,
    Strict,
}
#[derive(Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum DatabaseMode {
    Pglite,
    BundledPostgres,
    Postgres,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin_password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admin_bootstrap_token: Option<String>,
    pub allow_insecure_remote: bool,
    pub api_body_limit_bytes: u64,
    pub api_rate_limit_per_minute: u64,
    pub account_command_concurrency: u64,
    pub account_command_rate_per_minute: u64,
    pub account_relay_bytes_per_minute: u64,
    pub account_remote_surface_limit: u64,
    pub account_upload_bytes_per_minute: u64,
    pub account_upload_concurrency: u64,
    pub account_websocket_limit: u64,
    pub app_origins: Vec<String>,
    pub auth_rate_limit: u64,
    pub auth_mode: AuthMode,
    pub account_usage_daily_retention_days: u64,
    pub account_usage_flush_retention_days: u64,
    pub account_usage_hourly_retention_days: u64,
    pub account_usage_maintenance_interval_ms: u64,
    pub bandwidth_usage_flush_interval_ms: u64,
    pub bandwidth_usage_flush_threshold_bytes: u64,
    pub bandwidth_usage_max_buffered_entries: u64,
    pub bootstrap_mode: BootstrapMode,
    pub data_directory: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database_url: Option<String>,
    pub deployment_mode: DeploymentMode,
    pub agent_model: String,
    pub agent_model_provider: String,
    pub ollama_base_url: String,
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics_token: Option<String>,
    pub cookie_same_site: SameSite,
    pub cookie_secure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_hash: Option<String>,
    pub pairing_rate_limit_per_minute: u64,
    pub port: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_origin: Option<String>,
    pub public_registration: bool,
    pub license_whitelist_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redis_url: Option<String>,
    pub require_https: bool,
    pub scheduler_lease_ttl_ms: u64,
    pub storage_reconciliation_interval_ms: u64,
    pub session_ttl_seconds: u64,
    pub coordination_max_instances: u64,
    pub coordination_presence_ttl_ms: u64,
    pub worker_token: String,
    pub worker_link_peer: PeerConfig,
    pub remote_surface_web_rtc: WebRtcConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_encryption: Option<SecretEncryption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_instance_id: Option<String>,
    pub trusted_proxies: Vec<String>,
    pub upload_limit_bytes: u64,
    pub upload_rate_limit_per_minute: u64,
    pub websocket_handshake_rate_per_minute: u64,
    pub websocket_max_payload_bytes: u64,
    pub worker_command_concurrency: u64,
    pub worker_command_rate_per_minute: u64,
    pub worker_relay_bytes_per_minute: u64,
    pub worker_remote_surface_limit: u64,
    pub worker_upload_bytes_per_minute: u64,
    #[serde(skip)]
    pub database_mode: DatabaseMode,
    #[serde(skip)]
    pub postgres_bin_directory: Option<PathBuf>,
}

impl ServerConfig {
    pub fn read(environment: &Environment, cwd: &Path) -> Result<Self> {
        let e = Reader(environment);
        let host = e.text("CANTRIP_SERVER_HOST", "127.0.0.1");
        let worker_token = e.text("CANTRIP_WORKER_TOKEN", "cantrip-local-development");
        let deployment_mode =
            match enumeration(&e, "CANTRIP_DEPLOYMENT_MODE", "local", &["local", "hosted"])?
                .as_str()
            {
                "hosted" => DeploymentMode::Hosted,
                _ => DeploymentMode::Local,
            };
        let bootstrap_mode = match enumeration(
            &e,
            "CANTRIP_BOOTSTRAP_MODE",
            "pnpm-dev",
            &["pnpm-dev", "tauri", "standalone", "hosted"],
        )?
        .as_str()
        {
            "tauri" => BootstrapMode::Tauri,
            "standalone" => BootstrapMode::Standalone,
            "hosted" => BootstrapMode::Hosted,
            _ => BootstrapMode::PnpmDev,
        };
        let auth_mode = match enumeration(
            &e,
            "CANTRIP_AUTH_MODE",
            "none",
            &["none", "password", "accounts"],
        )?
        .as_str()
        {
            "password" => AuthMode::Password,
            "accounts" => AuthMode::Accounts,
            _ => AuthMode::None,
        };
        let secret_encryption = secret::read(&e)?;
        let allow_insecure_remote = e.boolean("CANTRIP_ALLOW_INSECURE_REMOTE")?;
        let password_hash = e.trimmed("CANTRIP_PASSWORD_HASH");
        if auth_mode == AuthMode::Password
            && password_hash
                .as_deref()
                .is_none_or(|h| !h.starts_with("$argon2id$"))
        {
            return Err(ConfigError::new(
                "CANTRIP_AUTH_MODE=password requires CANTRIP_PASSWORD_HASH to contain an Argon2id encoded hash.",
            ));
        }
        let admin_bootstrap_token = e.trimmed("CANTRIP_ADMIN_BOOTSTRAP_TOKEN");
        if admin_bootstrap_token
            .as_deref()
            .is_some_and(|v| !v.is_empty() && length(v) < 32)
        {
            return Err(ConfigError::new(
                "CANTRIP_ADMIN_BOOTSTRAP_TOKEN must contain at least 32 characters.",
            ));
        }
        let admin_email = e.nonempty("CANTRIP_ADMIN_EMAIL");
        if admin_email.as_deref().is_some_and(|v| !value::email(v)) {
            return Err(ConfigError::new(
                "CANTRIP_ADMIN_EMAIL must be a valid email address.",
            ));
        }
        let admin_password = e
            .get("CANTRIP_ADMIN_PASSWORD")
            .filter(|v| !v.is_empty())
            .map(String::from);
        if auth_mode == AuthMode::Accounts
            && let Some(password) = &admin_password
        {
            if admin_email.is_none() {
                return Err(ConfigError::new(
                    "CANTRIP_ADMIN_PASSWORD requires CANTRIP_ADMIN_EMAIL.",
                ));
            }
            if !(12..=1024).contains(&length(password)) {
                return Err(ConfigError::new(
                    "CANTRIP_ADMIN_PASSWORD must contain 12 to 1024 characters.",
                ));
            }
        }
        let license_whitelist_enabled = e.get("CANTRIP_LICENSE_WHITELIST_ENABLED").is_none()
            || e.boolean("CANTRIP_LICENSE_WHITELIST_ENABLED")?;
        if auth_mode == AuthMode::Accounts && license_whitelist_enabled && admin_email.is_none() {
            return Err(ConfigError::new(
                "CANTRIP_AUTH_MODE=accounts requires CANTRIP_ADMIN_EMAIL when the license whitelist is enabled.",
            ));
        }
        let metrics_token = e.trimmed("CANTRIP_METRICS_TOKEN");
        if metrics_token
            .as_deref()
            .is_some_and(|v| !v.is_empty() && length(v) < 32)
        {
            return Err(ConfigError::new(
                "CANTRIP_METRICS_TOKEN must contain at least 32 characters.",
            ));
        }
        let server_instance_id = e.nonempty("CANTRIP_SERVER_INSTANCE_ID");
        if server_instance_id.as_deref().is_some_and(|v| {
            length(v) > 100 || v.chars().any(|ch| ch <= '\u{001f}' || ch == '\u{007f}')
        }) {
            return Err(ConfigError::new("CANTRIP_SERVER_INSTANCE_ID is invalid."));
        }
        let redis_url = e.nonempty("REDIS_URL");
        if let Some(redis) = &redis_url {
            let parsed = Url::parse(redis).map_err(|_| {
                ConfigError::new("REDIS_URL must be a valid redis:// or rediss:// URL.")
            })?;
            if !["redis", "rediss"].contains(&parsed.scheme()) {
                return Err(ConfigError::new(
                    "REDIS_URL must use redis:// or rediss://.",
                ));
            }
        }
        let cookie_same_site_input = e.get("CANTRIP_COOKIE_SAME_SITE");
        if cookie_same_site_input.is_some_and(|v| !["lax", "none", "strict"].contains(&v)) {
            return Err(ConfigError::new(
                "Invalid CANTRIP_COOKIE_SAME_SITE: expected lax, none, or strict.",
            ));
        }
        let loopback = ["127.0.0.1", "localhost", "::1"].contains(&host.as_str());
        let hosted = deployment_mode == DeploymentMode::Hosted;
        if hosted && auth_mode == AuthMode::None {
            return Err(ConfigError::new(
                "Hosted deployments require CANTRIP_AUTH_MODE=accounts or password; CANTRIP_ALLOW_INSECURE_REMOTE cannot enable anonymous hosted access.",
            ));
        }
        if hosted && bootstrap_mode != BootstrapMode::Hosted {
            return Err(ConfigError::new(
                "Hosted deployments require CANTRIP_BOOTSTRAP_MODE=hosted so bootstrap capabilities describe the deployment truthfully.",
            ));
        }
        if hosted && allow_insecure_remote {
            return Err(ConfigError::new(
                "CANTRIP_ALLOW_INSECURE_REMOTE is not permitted in hosted mode.",
            ));
        }
        if auth_mode == AuthMode::None && (!loopback || hosted) && !allow_insecure_remote {
            return Err(ConfigError::new(
                "Unauthenticated remote access is disabled. Set CANTRIP_ALLOW_INSECURE_REMOTE=true only behind a trusted network or authenticating reverse proxy.",
            ));
        }
        let development_worker_bootstrap = !hosted
            && auth_mode == AuthMode::None
            && loopback
            && matches!(
                bootstrap_mode,
                BootstrapMode::PnpmDev | BootstrapMode::Tauri
            );
        if e.get("CANTRIP_WORKER_TOKEN").is_some() && !development_worker_bootstrap {
            return Err(ConfigError::new(
                "CANTRIP_WORKER_TOKEN is restricted to anonymous loopback pnpm-dev and Tauri bootstraps. Enroll standalone and hosted workers with a one-time link code.",
            ));
        }
        if hosted && secret_encryption.is_none() {
            return Err(ConfigError::new(
                "Hosted deployments require CANTRIP_SECRET_ENCRYPTION_KEYS so provider secrets can be encrypted at rest.",
            ));
        }
        let database_url = e.nonempty("DATABASE_URL");
        let explicitly_local_storage = matches!(
            e.get("CANTRIP_DATABASE_MODE"),
            Some("pglite" | "bundled-postgres")
        );
        if hosted && database_url.is_none() && !explicitly_local_storage {
            return Err(ConfigError::new(
                "Hosted deployments require DATABASE_URL for PostgreSQL.",
            ));
        }
        let app_origins = value::app_origins(&e, hosted)?;
        let trusted_proxies = value::trusted_proxies(&e, hosted)?;
        let port = e.bounded("CANTRIP_SERVER_PORT", 4310, 1, 65535)?;
        let public_origin_input = e.nonempty("CANTRIP_PUBLIC_ORIGIN");
        if hosted && public_origin_input.is_none() {
            return Err(ConfigError::new(
                "Hosted deployments require CANTRIP_PUBLIC_ORIGIN.",
            ));
        }
        let public_origin = public_origin_input
            .map(|v| value::origin("CANTRIP_PUBLIC_ORIGIN", &v, hosted))
            .transpose()?;
        // Constructor evaluation order follows the Node implementation, including
        // which configuration error wins when multiple settings are invalid.
        let mut config = Self {
            admin_email,
            admin_password,
            admin_bootstrap_token,
            allow_insecure_remote,
            api_body_limit_bytes: e.bounded(
                "CANTRIP_API_BODY_LIMIT_BYTES",
                1_024 * 1_024,
                16 * 1_024,
                16 * 1_024 * 1_024,
            )?,
            api_rate_limit_per_minute: e.bounded(
                "CANTRIP_API_RATE_LIMIT_PER_MINUTE",
                1_200,
                60,
                100_000,
            )?,
            account_command_concurrency: e.bounded(
                "CANTRIP_ACCOUNT_COMMAND_CONCURRENCY",
                128,
                1,
                10_000,
            )?,
            account_command_rate_per_minute: e.bounded(
                "CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE",
                2_400,
                60,
                100_000,
            )?,
            account_relay_bytes_per_minute: e.bounded(
                "CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE",
                512 * 1_024 * 1_024,
                1_024 * 1_024,
                64 * 1_024 * 1_024 * 1_024,
            )?,
            account_remote_surface_limit: e.bounded(
                "CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT",
                16,
                1,
                10_000,
            )?,
            account_upload_bytes_per_minute: e.bounded(
                "CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE",
                256 * 1_024 * 1_024,
                1_024 * 1_024,
                64 * 1_024 * 1_024 * 1_024,
            )?,
            account_upload_concurrency: e.bounded(
                "CANTRIP_ACCOUNT_UPLOAD_CONCURRENCY",
                4,
                1,
                1_000,
            )?,
            account_websocket_limit: e.bounded("CANTRIP_ACCOUNT_WEBSOCKET_LIMIT", 32, 1, 10_000)?,
            app_origins,
            auth_mode,
            auth_rate_limit: e.bounded("CANTRIP_AUTH_RATE_LIMIT", 10, 1, 1_000)?,
            account_usage_daily_retention_days: e.bounded(
                "CANTRIP_ACCOUNT_USAGE_DAILY_RETENTION_DAYS",
                400,
                31,
                3_650,
            )?,
            account_usage_flush_retention_days: e.bounded(
                "CANTRIP_ACCOUNT_USAGE_FLUSH_RETENTION_DAYS",
                7,
                1,
                90,
            )?,
            account_usage_hourly_retention_days: e.bounded(
                "CANTRIP_ACCOUNT_USAGE_HOURLY_RETENTION_DAYS",
                30,
                1,
                30,
            )?,
            account_usage_maintenance_interval_ms: e.bounded(
                "CANTRIP_ACCOUNT_USAGE_MAINTENANCE_INTERVAL_MS",
                60 * 60_000,
                60_000,
                24 * 60 * 60_000,
            )?,
            bandwidth_usage_flush_interval_ms: e.bounded(
                "CANTRIP_BANDWIDTH_USAGE_FLUSH_INTERVAL_MS",
                60_000,
                250,
                60_000,
            )?,
            bandwidth_usage_flush_threshold_bytes: e.bounded(
                "CANTRIP_BANDWIDTH_USAGE_FLUSH_THRESHOLD_BYTES",
                1024 * 1024,
                1024,
                1024 * 1024 * 1024,
            )?,
            bandwidth_usage_max_buffered_entries: e.bounded(
                "CANTRIP_BANDWIDTH_USAGE_MAX_BUFFERED_ENTRIES",
                4_096,
                64,
                65_536,
            )?,
            bootstrap_mode,
            coordination_max_instances: e.bounded(
                "CANTRIP_COORDINATION_MAX_INSTANCES",
                1,
                1,
                32,
            )?,
            coordination_presence_ttl_ms: e.bounded(
                "CANTRIP_COORDINATION_PRESENCE_TTL_MS",
                30_000,
                5_000,
                300_000,
            )?,
            scheduler_lease_ttl_ms: e.bounded(
                "CANTRIP_SCHEDULER_LEASE_TTL_MS",
                120_000,
                30_000,
                600_000,
            )?,
            storage_reconciliation_interval_ms: e.bounded(
                "CANTRIP_STORAGE_RECONCILIATION_INTERVAL_MS",
                60 * 60_000,
                60_000,
                24 * 60 * 60_000,
            )?,
            data_directory: value::resolve(
                cwd,
                Path::new(e.get("CANTRIP_DATA_DIR").unwrap_or("../.cantrip/dev")),
            ),
            database_url,
            deployment_mode,
            agent_model: e.text("CANTRIP_AGENT_MODEL", "gemma4:26b"),
            agent_model_provider: e.text("CANTRIP_AGENT_MODEL_PROVIDER", "ollama"),
            ollama_base_url: e.text("CANTRIP_OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1"),
            host,
            metrics_token,
            cookie_same_site: match cookie_same_site_input {
                Some("strict") => SameSite::Strict,
                Some("none") => SameSite::None,
                _ if hosted => SameSite::None,
                _ => SameSite::Lax,
            },
            cookie_secure: if e.get("CANTRIP_COOKIE_SECURE").is_none() {
                hosted
            } else {
                e.boolean("CANTRIP_COOKIE_SECURE")?
            },
            password_hash,
            pairing_rate_limit_per_minute: e.bounded(
                "CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE",
                20,
                1,
                10_000,
            )?,
            port,
            public_origin,
            public_registration: e.boolean("CANTRIP_PUBLIC_REGISTRATION")?,
            license_whitelist_enabled,
            redis_url,
            session_ttl_seconds: e.bounded(
                "CANTRIP_SESSION_TTL_SECONDS",
                30 * 24 * 60 * 60,
                300,
                365 * 24 * 60 * 60,
            )?,
            worker_token,
            worker_link_peer: peer::read(&e)?,
            remote_surface_web_rtc: peer::web_rtc(&e)?,
            require_https: hosted,
            secret_encryption,
            server_instance_id,
            trusted_proxies,
            upload_limit_bytes: e.bounded(
                "CANTRIP_UPLOAD_LIMIT_BYTES",
                25 * 1_024 * 1_024,
                1_024 * 1_024,
                1_024 * 1_024 * 1_024,
            )?,
            upload_rate_limit_per_minute: e.bounded(
                "CANTRIP_UPLOAD_RATE_LIMIT_PER_MINUTE",
                30,
                1,
                10_000,
            )?,
            websocket_handshake_rate_per_minute: e.bounded(
                "CANTRIP_WEBSOCKET_HANDSHAKE_RATE_PER_MINUTE",
                120,
                1,
                10_000,
            )?,
            websocket_max_payload_bytes: e.bounded(
                "CANTRIP_WEBSOCKET_MAX_PAYLOAD_BYTES",
                8 * 1_024 * 1_024,
                64 * 1_024,
                64 * 1_024 * 1_024,
            )?,
            worker_command_concurrency: e.bounded(
                "CANTRIP_WORKER_COMMAND_CONCURRENCY",
                64,
                1,
                10_000,
            )?,
            worker_command_rate_per_minute: e.bounded(
                "CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE",
                1_200,
                60,
                100_000,
            )?,
            worker_relay_bytes_per_minute: e.bounded(
                "CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE",
                256 * 1_024 * 1_024,
                1_024 * 1_024,
                64 * 1_024 * 1_024 * 1_024,
            )?,
            worker_remote_surface_limit: e.bounded(
                "CANTRIP_WORKER_REMOTE_SURFACE_LIMIT",
                8,
                1,
                10_000,
            )?,
            worker_upload_bytes_per_minute: e.bounded(
                "CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE",
                128 * 1_024 * 1_024,
                1_024 * 1_024,
                64 * 1_024 * 1_024 * 1_024,
            )?,
            database_mode: match e.get("CANTRIP_DATABASE_MODE") {
                Some("pglite") => DatabaseMode::Pglite,
                Some("bundled-postgres") => DatabaseMode::BundledPostgres,
                Some("postgres") => DatabaseMode::Postgres,
                Some(_) => {
                    return Err(ConfigError::new(
                        "Invalid CANTRIP_DATABASE_MODE: expected pglite, bundled-postgres, or postgres.",
                    ));
                }
                None if e.nonempty("DATABASE_URL").is_some() => DatabaseMode::Postgres,
                None => DatabaseMode::Pglite,
            },
            postgres_bin_directory: e
                .get("CANTRIP_POSTGRES_BIN_DIR")
                .map(|v| value::resolve(cwd, Path::new(v))),
        };
        if config.cookie_same_site == SameSite::None && !config.cookie_secure {
            return Err(ConfigError::new(
                "CANTRIP_COOKIE_SAME_SITE=none requires CANTRIP_COOKIE_SECURE=true.",
            ));
        }
        let divisor = config.coordination_max_instances;
        if divisor > 1 && config.redis_url.is_none() {
            return Err(ConfigError::new(
                "CANTRIP_COORDINATION_MAX_INSTANCES above 1 requires REDIS_URL.",
            ));
        }
        if divisor > 1 {
            for (name, value) in [
                (
                    "CANTRIP_API_RATE_LIMIT_PER_MINUTE",
                    &mut config.api_rate_limit_per_minute,
                ),
                ("CANTRIP_AUTH_RATE_LIMIT", &mut config.auth_rate_limit),
                (
                    "CANTRIP_PAIRING_RATE_LIMIT_PER_MINUTE",
                    &mut config.pairing_rate_limit_per_minute,
                ),
                (
                    "CANTRIP_UPLOAD_RATE_LIMIT_PER_MINUTE",
                    &mut config.upload_rate_limit_per_minute,
                ),
                (
                    "CANTRIP_WEBSOCKET_HANDSHAKE_RATE_PER_MINUTE",
                    &mut config.websocket_handshake_rate_per_minute,
                ),
                (
                    "CANTRIP_ACCOUNT_COMMAND_CONCURRENCY",
                    &mut config.account_command_concurrency,
                ),
                (
                    "CANTRIP_ACCOUNT_COMMAND_RATE_PER_MINUTE",
                    &mut config.account_command_rate_per_minute,
                ),
                (
                    "CANTRIP_ACCOUNT_RELAY_BYTES_PER_MINUTE",
                    &mut config.account_relay_bytes_per_minute,
                ),
                (
                    "CANTRIP_ACCOUNT_REMOTE_SURFACE_LIMIT",
                    &mut config.account_remote_surface_limit,
                ),
                (
                    "CANTRIP_ACCOUNT_UPLOAD_BYTES_PER_MINUTE",
                    &mut config.account_upload_bytes_per_minute,
                ),
                (
                    "CANTRIP_ACCOUNT_UPLOAD_CONCURRENCY",
                    &mut config.account_upload_concurrency,
                ),
                (
                    "CANTRIP_ACCOUNT_WEBSOCKET_LIMIT",
                    &mut config.account_websocket_limit,
                ),
                (
                    "CANTRIP_WORKER_COMMAND_CONCURRENCY",
                    &mut config.worker_command_concurrency,
                ),
                (
                    "CANTRIP_WORKER_COMMAND_RATE_PER_MINUTE",
                    &mut config.worker_command_rate_per_minute,
                ),
                (
                    "CANTRIP_WORKER_RELAY_BYTES_PER_MINUTE",
                    &mut config.worker_relay_bytes_per_minute,
                ),
                (
                    "CANTRIP_WORKER_REMOTE_SURFACE_LIMIT",
                    &mut config.worker_remote_surface_limit,
                ),
                (
                    "CANTRIP_WORKER_UPLOAD_BYTES_PER_MINUTE",
                    &mut config.worker_upload_bytes_per_minute,
                ),
            ] {
                if *value < divisor {
                    return Err(ConfigError::new(format!(
                        "{name} must be at least CANTRIP_COORDINATION_MAX_INSTANCES."
                    )));
                }
                *value /= divisor;
            }
        }
        Ok(config)
    }
}
