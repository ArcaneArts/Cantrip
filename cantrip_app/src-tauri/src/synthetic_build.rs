#![cfg_attr(debug_assertions, allow(dead_code))]

use std::time::Duration;

use reqwest::{header::LINK, Client, Response};
use serde::{Deserialize, Serialize};

const COMMITS_URL: &str = "https://api.github.com/repos/ArcaneArts/Cantrip/commits";
const COMPARE_URL: &str = "https://api.github.com/repos/ArcaneArts/Cantrip/compare";
const RAW_REPOSITORY_URL: &str = "https://raw.githubusercontent.com/ArcaneArts/Cantrip";
const COMMIT_PAGE_SIZE: usize = 50;
const COMMIT_MAX_PAGE: usize = 2_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildCapability {
    available: bool,
    platform: Option<&'static str>,
    reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticCommit {
    sha: String,
    short_sha: String,
    subject: String,
    author_name: String,
    authored_at: String,
    commit_count: Option<u64>,
    synthetic_version: Option<String>,
    buildable: Option<bool>,
    reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticCommitPage {
    commits: Vec<SyntheticCommit>,
    next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntheticBuildError {
    code: &'static str,
    message: String,
    retryable: bool,
}

impl SyntheticBuildError {
    fn new(code: &'static str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
        }
    }

    fn unavailable() -> Self {
        Self::new(
            "synthetic_build_unavailable",
            synthetic_build_unavailable_reason(),
            false,
        )
    }
}

#[derive(Debug, Deserialize)]
struct GithubCommitIdentity {
    date: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct GithubCommitDetails {
    author: Option<GithubCommitIdentity>,
    committer: Option<GithubCommitIdentity>,
    message: String,
}

#[derive(Debug, Deserialize)]
struct GithubCommit {
    commit: GithubCommitDetails,
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GithubComparison {
    status: String,
}

#[derive(Debug, Deserialize)]
struct VersionConfig {
    major: u64,
    minor: u64,
}

fn supported_platform() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("darwin-arm64")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("win32-x64")
    } else {
        None
    }
}

fn synthetic_build_is_available(desktop: bool, debug: bool, platform: Option<&str>) -> bool {
    desktop && !debug && platform.is_some()
}

fn synthetic_build_available() -> bool {
    synthetic_build_is_available(cfg!(desktop), cfg!(debug_assertions), supported_platform())
}

fn synthetic_build_unavailable_reason() -> String {
    if !cfg!(desktop) {
        "Synthetic builds are available only in the Cantrip desktop app.".into()
    } else if cfg!(debug_assertions) {
        "Synthetic builds are disabled in development builds.".into()
    } else if cfg!(target_os = "macos") {
        "Synthetic builds currently require Apple Silicon macOS.".into()
    } else if cfg!(target_os = "windows") {
        "Synthetic builds currently require 64-bit Windows.".into()
    } else {
        "Synthetic builds are currently supported only on macOS and Windows.".into()
    }
}

fn github_client() -> Result<Client, SyntheticBuildError> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("Cantrip-Synthetic-Builder")
        .build()
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_commit_request_failed",
                format!("Could not prepare the Cantrip commit request: {error}"),
                true,
            )
        })
}

async fn github_response(
    request: reqwest::RequestBuilder,
    failure_message: &str,
) -> Result<Response, SyntheticBuildError> {
    request
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .and_then(Response::error_for_status)
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_commit_request_failed",
                format!("{failure_message}: {error}"),
                true,
            )
        })
}

fn parse_cursor(cursor: Option<&str>) -> Result<usize, SyntheticBuildError> {
    let page = cursor.unwrap_or("1").parse::<usize>().map_err(|_| {
        SyntheticBuildError::new(
            "synthetic_commit_cursor_invalid",
            "The commit-list cursor was invalid.",
            false,
        )
    })?;
    if !(1..=COMMIT_MAX_PAGE).contains(&page) {
        return Err(SyntheticBuildError::new(
            "synthetic_commit_cursor_invalid",
            "The commit-list cursor was outside the supported range.",
            false,
        ));
    }
    Ok(page)
}

fn validate_full_sha(sha: &str) -> Result<&str, SyntheticBuildError> {
    if sha.len() != 40
        || !sha
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SyntheticBuildError::new(
            "synthetic_commit_invalid",
            "A full lowercase 40-character Git commit SHA is required.",
            false,
        ));
    }
    Ok(sha)
}

fn commit_subject(message: &str) -> String {
    message
        .lines()
        .next()
        .unwrap_or("Untitled commit")
        .trim()
        .chars()
        .take(500)
        .collect()
}

fn map_commit(commit: GithubCommit) -> Result<SyntheticCommit, SyntheticBuildError> {
    validate_full_sha(&commit.sha)?;
    let identity = commit
        .commit
        .author
        .or(commit.commit.committer)
        .ok_or_else(|| {
            SyntheticBuildError::new(
                "synthetic_commit_invalid",
                format!("Commit {} did not include author metadata.", commit.sha),
                true,
            )
        })?;
    Ok(SyntheticCommit {
        short_sha: commit.sha.chars().take(8).collect(),
        sha: commit.sha,
        subject: commit_subject(&commit.commit.message),
        author_name: identity.name,
        authored_at: identity.date,
        commit_count: None,
        synthetic_version: None,
        buildable: None,
        reason: None,
    })
}

fn last_page_from_link(value: &str) -> Option<u64> {
    value.split(',').find_map(|part| {
        let mut sections = part.trim().split(';');
        let url = sections
            .next()?
            .trim()
            .trim_start_matches('<')
            .trim_end_matches('>');
        let relation = sections.next()?.trim();
        if relation != r#"rel="last""# {
            return None;
        }
        url::Url::parse(url)
            .ok()?
            .query_pairs()
            .find_map(|(key, value)| (key == "page").then(|| value.parse().ok()).flatten())
    })
}

async fn resolve_commit_count(client: &Client, sha: &str) -> Result<u64, SyntheticBuildError> {
    let response = github_response(
        client
            .get(COMMITS_URL)
            .query(&[("sha", sha), ("per_page", "1"), ("page", "1")]),
        "Could not calculate the selected Cantrip commit version",
    )
    .await?;
    let count = response
        .headers()
        .get(LINK)
        .and_then(|value| value.to_str().ok())
        .and_then(last_page_from_link)
        .unwrap_or(1);
    let commits = response
        .json::<Vec<GithubCommit>>()
        .await
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_commit_invalid",
                format!("The selected commit-count response was invalid: {error}"),
                true,
            )
        })?;
    if commits.is_empty() {
        return Err(SyntheticBuildError::new(
            "synthetic_commit_invalid",
            "The selected commit could not be resolved.",
            false,
        ));
    }
    Ok(count)
}

#[tauri::command]
pub fn synthetic_build_capability() -> SyntheticBuildCapability {
    let platform = supported_platform();
    SyntheticBuildCapability {
        available: synthetic_build_available(),
        platform,
        reason: (!synthetic_build_available()).then(synthetic_build_unavailable_reason),
    }
}

#[tauri::command]
pub async fn list_synthetic_build_commits(
    cursor: Option<String>,
) -> Result<SyntheticCommitPage, SyntheticBuildError> {
    if !synthetic_build_available() {
        return Err(SyntheticBuildError::unavailable());
    }
    let page = parse_cursor(cursor.as_deref())?;
    let client = github_client()?;
    let response = github_response(
        client.get(COMMITS_URL).query(&[
            ("sha", "main".to_string()),
            ("per_page", COMMIT_PAGE_SIZE.to_string()),
            ("page", page.to_string()),
        ]),
        "Could not load commits from Cantrip main",
    )
    .await?;
    let commits = response
        .json::<Vec<GithubCommit>>()
        .await
        .map_err(|error| {
            SyntheticBuildError::new(
                "synthetic_commit_invalid",
                format!("The Cantrip commit list was invalid: {error}"),
                true,
            )
        })?;
    let count = commits.len();
    let commits = commits
        .into_iter()
        .map(map_commit)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SyntheticCommitPage {
        commits,
        next_cursor: (count == COMMIT_PAGE_SIZE).then(|| (page + 1).to_string()),
    })
}

#[tauri::command]
pub async fn resolve_synthetic_build_target(
    sha: String,
) -> Result<SyntheticCommit, SyntheticBuildError> {
    if !synthetic_build_available() {
        return Err(SyntheticBuildError::unavailable());
    }
    let sha = validate_full_sha(&sha)?.to_string();
    let client = github_client()?;
    let commit_response = github_response(
        client.get(format!("{COMMITS_URL}/{sha}")),
        "Could not resolve the selected Cantrip commit",
    )
    .await?;
    let mut commit = map_commit(commit_response.json::<GithubCommit>().await.map_err(
        |error| {
            SyntheticBuildError::new(
                "synthetic_commit_invalid",
                format!("The selected Cantrip commit was invalid: {error}"),
                true,
            )
        },
    )?)?;

    let comparison = github_response(
        client.get(format!("{COMPARE_URL}/{sha}...main")),
        "Could not verify the selected commit against Cantrip main",
    )
    .await?
    .json::<GithubComparison>()
    .await
    .map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_commit_invalid",
            format!("The selected commit comparison was invalid: {error}"),
            true,
        )
    })?;
    if !matches!(comparison.status.as_str(), "ahead" | "identical") {
        return Err(SyntheticBuildError::new(
            "synthetic_commit_not_on_main",
            "The selected commit is no longer reachable from Cantrip main.",
            false,
        ));
    }

    let version = github_response(
        client.get(format!("{RAW_REPOSITORY_URL}/{sha}/version.json")),
        "Could not read version.json from the selected commit",
    )
    .await?
    .json::<VersionConfig>()
    .await
    .map_err(|error| {
        SyntheticBuildError::new(
            "synthetic_commit_unsupported",
            format!("The selected commit has unsupported version metadata: {error}"),
            false,
        )
    })?;
    let commit_count = resolve_commit_count(&client, &sha).await?;
    commit.commit_count = Some(commit_count);
    commit.synthetic_version = Some(format!(
        "{}.{}.{commit_count}-x",
        version.major, version.minor
    ));
    commit.buildable = Some(true);
    Ok(commit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_requires_packaged_supported_desktop() {
        assert!(synthetic_build_is_available(
            true,
            false,
            Some("darwin-arm64")
        ));
        assert!(!synthetic_build_is_available(
            false,
            false,
            Some("darwin-arm64")
        ));
        assert!(!synthetic_build_is_available(
            true,
            true,
            Some("darwin-arm64")
        ));
        assert!(!synthetic_build_is_available(true, false, None));
    }

    #[test]
    fn validates_full_immutable_commit_sha() {
        assert!(validate_full_sha("0123456789abcdef0123456789abcdef01234567").is_ok());
        assert!(validate_full_sha("0123456").is_err());
        assert!(validate_full_sha("0123456789ABCDEF0123456789abcdef01234567").is_err());
    }

    #[test]
    fn extracts_last_page_as_commit_count() {
        assert_eq!(
            last_page_from_link(
                r#"<https://api.github.com/repositories/1/commits?sha=a&per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/commits?sha=a&per_page=1&page=1375>; rel="last""#,
            ),
            Some(1375),
        );
        assert_eq!(last_page_from_link(""), None);
    }

    #[test]
    fn truncates_commit_messages_to_a_subject() {
        assert_eq!(
            commit_subject("  Subject line  \n\nDetails"),
            "Subject line"
        );
        assert_eq!(commit_subject(""), "Untitled commit");
    }
}
