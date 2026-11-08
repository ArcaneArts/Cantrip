//! Reference routing grammar and request-target decoding.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::LazyLock};

#[derive(Deserialize, Serialize, PartialEq, Debug)]
pub(super) struct Registration {
    method: String,
    path: String,
    pub(super) level: String,
}
#[derive(Default)]
struct Node {
    literal: HashMap<String, Node>,
    parameter: Option<Box<Node>>,
    exact: Option<usize>,
    wildcard: Option<usize>,
}
#[derive(Debug, Serialize, PartialEq)]
pub(super) struct TargetError {
    pub code: &'static str,
    pub path: String,
}
impl TargetError {
    pub(super) fn status(&self) -> u16 {
        if self.code == "FST_ERR_BAD_URL" {
            400
        } else {
            414
        }
    }
    pub(super) fn message(&self) -> String {
        let suffix = if self.status() == 400 {
            "is not a valid url component"
        } else {
            "is exceeding the max param length"
        };
        format!("'{}' {suffix}", self.path)
    }
}
fn decoded_path(target: &str) -> Result<String, TargetError> {
    let target = if target.starts_with("http://") || target.starts_with("https://") {
        let authority = target.find("://").unwrap() + 3;
        target[authority..]
            .find('/')
            .map_or(target, |slash| &target[authority + slash..])
    } else {
        target
    };
    let path = target.split(['?', '#']).next().unwrap_or(target);
    let mut decoded = Vec::with_capacity(path.len());
    let mut bytes = path.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            decoded.push(byte);
            continue;
        }
        let pair = bytes.next().zip(bytes.next());
        let hex = pair.and_then(|(high, low)| {
            Some(((high as char).to_digit(16)? * 16 + (low as char).to_digit(16)?) as u8)
        });
        let Some(hex) = hex else {
            return Err(TargetError {
                code: "FST_ERR_BAD_URL",
                path: target.into(),
            });
        };
        if b"#$&+,/:;=?@%".contains(&hex) {
            let (high, low) = pair.unwrap();
            decoded.extend([b'%', high, low]);
        } else {
            decoded.push(hex);
        }
    }
    String::from_utf8(decoded).map_err(|_| TargetError {
        code: "FST_ERR_BAD_URL",
        path: target.into(),
    })
}
impl Node {
    fn insert(&mut self, mut parts: std::str::Split<'_, char>, index: usize) {
        let Some(part) = parts.next() else {
            self.exact = Some(index);
            return;
        };
        if part == "*" {
            self.wildcard = Some(index);
        } else if part.starts_with(':') {
            self.parameter
                .get_or_insert_with(Default::default)
                .insert(parts, index);
        } else {
            self.literal
                .entry(part.into())
                .or_default()
                .insert(parts, index);
        }
    }
    fn find(&self, mut parts: std::str::Split<'_, char>, too_long: &mut bool) -> Option<usize> {
        let Some(part) = parts.next() else {
            return self.exact;
        };
        if let Some(index) = self
            .literal
            .get(part)
            .and_then(|node| node.find(parts.clone(), too_long))
        {
            return Some(index);
        }
        if let Some(parameter) = &self.parameter {
            // decodeURI has validated all escapes and UTF8 already. Reserved
            // component escapes are decoded once, without treating '+' as space.
            let value = percent_encoding::percent_decode_str(part)
                .decode_utf8()
                .expect("validated URI");
            if value.encode_utf16().count() > 100 {
                *too_long = true;
            } else if let Some(index) = parameter.find(parts, too_long) {
                return Some(index);
            }
        }
        self.wildcard
    }
}
struct Table {
    routes: Vec<Registration>,
    methods: HashMap<String, Node>,
}
impl Table {
    fn new(routes: Vec<Registration>) -> Self {
        let mut methods: HashMap<String, Node> = HashMap::new();
        for (index, row) in routes.iter().enumerate() {
            let node = methods.entry(row.method.clone()).or_default();
            node.insert(
                row.path.strip_prefix('/').unwrap_or(&row.path).split('/'),
                index,
            );
        }
        Self { routes, methods }
    }
    fn find(&self, method: &str, target: &str) -> Result<Option<&Registration>, TargetError> {
        let Some(node) = self.methods.get(method) else {
            return Ok(None);
        };
        let path = decoded_path(target)?;
        let mut too_long = false;
        let index = if let Some(path) = path.strip_prefix('/') {
            node.find(path.split('/'), &mut too_long)
        } else {
            node.wildcard
        };
        if index.is_none() && too_long {
            return Err(TargetError {
                code: "FST_ERR_MAX_PARAM_LENGTH",
                path,
            });
        }
        Ok(index.map(|index| &self.routes[index]))
    }
}
static TABLE: LazyLock<Table> = LazyLock::new(|| {
    #[derive(Deserialize)]
    struct Manifest {
        routes: Vec<Registration>,
    }
    let manifest: Manifest =
        serde_json::from_str(include_str!("../../contracts/http-logging.json"))
            .expect("embedded HTTP logging routes");
    Table::new(manifest.routes)
});
pub(super) fn find(
    method: &str,
    target: &str,
) -> Result<Option<&'static Registration>, TargetError> {
    TABLE.find(method, target)
}
pub(super) fn known_method(method: &str) -> bool {
    TABLE.methods.contains_key(method)
}

pub(super) fn routing_uri(
    method: &str,
    uri: &axum::http::Uri,
) -> Result<axum::http::Uri, TargetError> {
    find(method, &uri.to_string())?;
    let decoded = decoded_path(&uri.to_string())?;
    if !known_method(method) {
        return Ok(uri.clone());
    }
    // HTTP Uri requires ASCII. Keep reserved escapes and re-encode characters
    // outside the path grammar; Axum's Path extractor decodes parameters once.
    let mut path = String::new();
    for byte in decoded.bytes() {
        if byte.is_ascii_graphic()
            && !matches!(byte, b'"' | b'<' | b'>' | b'`' | b'{' | b'}' | b'\\')
        {
            path.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(path, "%{byte:02X}").unwrap();
        }
    }
    if let Some(query) = uri.query() {
        path.push('?');
        path.push_str(query);
    }
    let mut parts = uri.clone().into_parts();
    parts.path_and_query = Some(path.parse().expect("encoded request target"));
    Ok(axum::http::Uri::from_parts(parts).expect("original URI parts"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{Context, Result};
    use std::{path::PathBuf, process::Command};
    #[test]
    fn route_policy_matches_actual_registration_and_reference_router() -> Result<()> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let directory = tempfile::tempdir()?;
        let report = directory.path().join("routes.json");
        let output = Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/http-log-policy-oracle.mjs",
                "--report",
            ])
            .arg(&report)
            .current_dir(root)
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Actual route oracle: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let corpus: serde_json::Value = serde_json::from_slice(&std::fs::read(report)?)?;
        assert_eq!(
            serde_json::to_value(&TABLE.routes)?,
            corpus["routes"],
            "Every actual production route level, including implicit HEAD and CORS"
        );
        let mut routers: HashMap<&str, matchit::Router<usize>> = HashMap::new();
        for (index, row) in TABLE.routes.iter().enumerate() {
            if row.path == "*" {
                continue;
            }
            let path = row
                .path
                .split('/')
                .map(|part| {
                    part.strip_prefix(':')
                        .map_or_else(|| part.to_owned(), |name| format!("{{{name}}}"))
                })
                .collect::<Vec<_>>()
                .join("/");
            routers
                .entry(&row.method)
                .or_default()
                .insert(path, index)?;
        }
        for (index, probe) in corpus["probes"]
            .as_array()
            .context("router probes")?
            .iter()
            .enumerate()
        {
            let found = TABLE.find(
                probe["method"].as_str().unwrap(),
                probe["target"].as_str().unwrap(),
            );
            assert_eq!(
                serde_json::to_value(found.as_ref().ok().and_then(|row| *row))?,
                probe["matched"],
                "reference router probe{index}: {} {}",
                probe["method"],
                probe["target"]
            );
            assert_eq!(
                serde_json::to_value(found.err())?,
                probe["error"],
                "target error probe{index}: {probe}"
            );
            if let Ok(Some(row)) = TABLE.find(
                probe["method"].as_str().unwrap(),
                probe["target"].as_str().unwrap(),
            ) && row.path != "*"
            {
                let target = probe["target"].as_str().unwrap().parse()?;
                let uri =
                    routing_uri(&row.method, &target).map_err(|e| anyhow::anyhow!("{e:?}"))?;
                let matched = routers[row.method.as_str()].at(uri.path())?;
                assert_eq!(
                    &TABLE.routes[*matched.value], row,
                    "native matchit probe{index}"
                );
                // Preserve the actual decoded parameter values, including empty
                // strings and reserved '%' or '/', through the patched engine.
                let params: serde_json::Map<String, serde_json::Value> = matched
                    .params
                    .iter()
                    .map(|(key, value)| {
                        (
                            key.to_owned(),
                            serde_json::Value::String(
                                percent_encoding::percent_decode_str(value)
                                    .decode_utf8()
                                    .unwrap()
                                    .into_owned(),
                            ),
                        )
                    })
                    .collect();
                assert_eq!(
                    serde_json::Value::Object(params),
                    probe["params"],
                    "native decoded params probe{index}"
                );
            }
        }
        Ok(())
    }
}
