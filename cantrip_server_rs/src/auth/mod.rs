pub mod audit;
pub mod cookie;
pub mod crypto;
pub mod rate_limit;
pub mod repository;
pub mod security_repository;
pub mod service;
pub mod validation;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

pub const LOCAL_USER_ID: &str = "00000000-0000-0000-0000-000000000001";

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserKind {
    Anonymous,
    Account,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Owner,
    Admin,
    #[default]
    Member,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    pub id: String,
    pub kind: UserKind,
    pub display_name: String,
    pub email: Option<String>,
    #[serde(default)]
    pub role: UserRole,
}

#[derive(Clone)]
pub struct ActiveSession {
    pub id: String,
    pub user: UserSummary,
    pub auth_method: String,
    pub csrf_token_hash: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub current_user: Option<UserSummary>,
    pub csrf_token: Option<String>,
    pub expires_at: Option<String>,
}

pub(crate) fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn now() -> DateTime<Utc> {
    DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap()
}
