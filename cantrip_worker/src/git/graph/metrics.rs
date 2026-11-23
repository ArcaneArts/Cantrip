use super::*;
use futures::{StreamExt, stream};
#[derive(Clone)]
struct Mutable {
    additions: u64,
    binary_touches: u64,
    binary: Option<bool>,
    touches: u64,
    deletions: u64,
    first: Option<String>,
    last: Option<String>,
    lines: Option<u64>,
}
impl Mutable {
    fn new(node: &Value, previous: Option<&Value>) -> Self {
        let empty = Value::Null;
        let previous = previous.unwrap_or(&empty);
        Self {
            additions: previous["additions"].as_u64().unwrap_or(0),
            binary_touches: previous["binaryCommitTouches"].as_u64().unwrap_or(0),
            binary: if node["kind"] == "file" {
                Some(false)
            } else {
                None
            },
            touches: previous["commitTouches"].as_u64().unwrap_or(0),
            deletions: previous["deletions"].as_u64().unwrap_or(0),
            first: previous["firstChangedAt"].as_str().map(str::to_owned),
            last: previous["lastChangedAt"].as_str().map(str::to_owned),
            lines: if node["kind"] == "directory" {
                Some(0)
            } else {
                None
            },
        }
    }
    fn changed(&mut self, date: &str) {
        if self.first.as_deref().is_none_or(|first| date < first) {
            self.first = Some(date.to_owned());
        }
        if self.last.as_deref().is_none_or(|last| date > last) {
            self.last = Some(date.to_owned());
        }
    }
    fn value(&self, node: &Value, blame: Option<&Blame>) -> Value {
        // Stable author insertion order resolves ties, matching Array.sort.
        let dominant = blame.and_then(|blame| {
            blame
                .authors
                .values()
                .enumerate()
                .max_by_key(|(i, author)| (author.lines, std::cmp::Reverse(*i)))
                .map(|(_, author)| author)
        });
        let line_count = blame.map(|blame| blame.lines).unwrap_or(0);
        json!({"nodeId":node["id"],"path":node["path"],"lineCount":self.lines,"binary":self.binary,
            "commitTouches":self.touches,"additions":self.additions,"deletions":self.deletions,
            "churn":self.additions+self.deletions,"binaryCommitTouches":self.binary_touches,
            "firstChangedAt":self.first,"lastChangedAt":self.last,
            "dominantAuthorName":dominant.map(|author| &author.name),
            "dominantAuthorEmail":dominant.map(|author| &author.email),
            "dominantAuthorShare":dominant.filter(|_| line_count>0).map(|author| author.lines as f64/line_count as f64),
            "averageBlameAgeDays":blame.filter(|_| line_count>0).map(|blame| blame.age/line_count as f64)})
    }
}
#[derive(Clone)]
struct Author {
    name: String,
    email: String,
    lines: u64,
}
#[derive(Default)]
struct Blame {
    authors: IndexMap<String, Author>,
    lines: u64,
    age: f64,
}
impl Blame {
    fn merge(&mut self, other: &Self) {
        self.lines += other.lines;
        self.age += other.age;
        for (key, author) in &other.authors {
            let current = self.authors.entry(key.clone()).or_insert_with(|| Author {
                lines: 0,
                ..author.clone()
            });
            current.lines += author.lines;
        }
    }
}
fn parse_blame(output: &str, now: i64) -> Blame {
    let mut result = Blame::default();
    let (mut name, mut email, mut authored) = ("Unknown", "", 0.0);
    for line in output.split('\n') {
        let hash = line.split_once(' ').map(|(hash, _)| hash).unwrap_or("");
        if (40..=64).contains(&hash.len())
            && hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'^')
        {
            (name, email, authored) = ("Unknown", "", 0.0);
        } else if let Some(author) = line.strip_prefix("author ") {
            name = if author.is_empty() { "Unknown" } else { author };
        } else if let Some(author) = line.strip_prefix("author-mail ") {
            email = author.strip_prefix('<').unwrap_or(author);
            email = email.strip_suffix('>').unwrap_or(email);
        } else if let Some(seconds) = line.strip_prefix("author-time ") {
            authored = seconds
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .unwrap_or(0.0)
                * 1000.0;
        } else if line.starts_with('\t') {
            result
                .authors
                .entry(format!("{email}\0{name}"))
                .or_insert_with(|| Author {
                    name: name.to_owned(),
                    email: email.to_owned(),
                    lines: 0,
                })
                .lines += 1;
            result.lines += 1;
            result.age += if authored != 0.0 {
                ((now as f64 - authored) / 86_400_000.0).max(0.0)
            } else {
                0.0
            };
        }
    }
    result
}
type Metrics = IndexMap<JsString, Mutable>;
async fn blame(
    cwd: &Path,
    snapshot: &Value,
    metrics: &Metrics,
    scope: &Scope,
) -> Result<(IndexMap<JsString, Blame>, Value)> {
    let nodes = snapshot["nodes"].as_array().unwrap();
    let eligible: Vec<_> = nodes
        .iter()
        .filter(|node| {
            let metrics = &metrics[node["id"].as_js_string().unwrap()];
            node["kind"] == "file"
                && node["path"].as_js_string().is_some()
                && metrics.binary == Some(false)
                && metrics.lines.unwrap_or(0) > 0
        })
        .collect();
    let mut selected = Vec::new();
    let mut lines = 0;
    for node in &eligible {
        let count = metrics[node["id"].as_js_string().unwrap()]
            .lines
            .unwrap_or(0);
        if selected.len() >= 80 || lines + count > 75_000 {
            continue;
        }
        selected.push(*node);
        lines += count;
    }
    let now = chrono::Utc::now().timestamp_millis();
    let work: Vec<Value> = selected.iter().map(|node| (*node).clone()).collect();
    let mut results: Vec<_> = stream::iter(work.into_iter().enumerate())
        .map(|(index, node)| async move {
            let output = raw(
                cwd,
                &[
                    "blame",
                    "--line-porcelain",
                    snapshot["revision"].as_str().unwrap(),
                    "--",
                    node["path"].as_str().unwrap(),
                ],
                scope,
                false,
            )
            .await;
            (
                index,
                node,
                output.ok().map(|output| parse_blame(&output, now)),
            )
        })
        .buffer_unordered(3)
        .collect()
        .await;
    // Accepted collectors finish and reap before propagating runtime stop.
    scope.check()?;
    results.sort_by_key(|(index, _, _)| *index);
    let mut by_id: IndexMap<JsString, Blame> = IndexMap::new();
    let mut analyzed = 0usize;
    for (_, node, summary) in results {
        let Some(summary) = summary else {
            continue;
        };
        analyzed += 1;
        for ancestor in ancestors(
            node["path"].as_js_string().unwrap(),
            snapshot["rootPath"].as_js_string(),
        ) {
            by_id.entry(ancestor).or_default().merge(&summary);
        }
        by_id.insert(node["id"].as_js_string().unwrap().clone(), summary);
    }
    Ok((
        by_id,
        json!({"analyzedFiles":analyzed,"totalFiles":eligible.len(),"truncated":selected.len()<eligible.len()||analyzed<selected.len()}),
    ))
}
fn counts(output: &str, revision: &str) -> IndexMap<JsString, u64> {
    let mut result = IndexMap::new();
    let mut tail = output;
    while let Some((path, rest)) = tail.split_once('\0') {
        let Some((count, rest)) = rest.split_once('\n') else {
            break;
        };
        let prefix = format!("{revision}:");
        let path = path
            .strip_prefix(&prefix)
            .unwrap_or_else(|| path.split_once(':').map_or(path, |(_, path)| path));
        if !path.is_empty()
            && let Ok(count) = count.parse()
        {
            result.insert(path.into(), count);
        }
        tail = rest;
    }
    result
}
fn history(
    output: &str,
    root: Option<&JsString>,
    metrics: &mut Metrics,
    paths: &IndexMap<JsString, JsString>,
) {
    for record in output.split('\x1e') {
        let Some((_, rest)) = record.split_once('\0') else {
            continue;
        };
        let Some((date, rest)) = rest.split_once('\0') else {
            continue;
        };
        if date.is_empty() {
            continue;
        }
        let (mut touched, mut directories, mut binaries) =
            (IndexSet::new(), IndexSet::new(), IndexSet::new());
        for raw in rest.split('\0') {
            let Some((added, rest)) = raw.split_once('\t') else {
                continue;
            };
            let Some((removed, path)) = rest.split_once('\t') else {
                continue;
            };
            let path = JsString::from(path);
            if path.is_empty() || !within(&path, root) {
                continue;
            }
            let Some(id) = paths.get(&path) else {
                continue;
            };
            let added = added.trim_start_matches('\n').parse::<u64>().ok();
            let removed = removed.parse::<u64>().ok();
            let binary = added.is_none() || removed.is_none();
            let Some(node) = metrics.get_mut(id) else {
                continue;
            };
            if touched.insert(id.clone()) {
                node.touches += 1;
                if binary {
                    node.binary_touches += 1;
                }
            }
            node.changed(date);
            node.additions += added.unwrap_or(0);
            node.deletions += removed.unwrap_or(0);
            for ancestor in ancestors(&path, root) {
                let Some(node) = metrics.get_mut(&ancestor) else {
                    continue;
                };
                if directories.insert(ancestor.clone()) {
                    node.touches += 1;
                }
                if binary && binaries.insert(ancestor) {
                    node.binary_touches += 1;
                }
                node.changed(date);
                node.additions += added.unwrap_or(0);
                node.deletions += removed.unwrap_or(0);
            }
        }
    }
}
async fn create(
    cwd: &Path,
    snapshot: &Value,
    include_blame: bool,
    previous: Option<&Value>,
    scope: &Scope,
) -> Result<Value> {
    let nodes = snapshot["nodes"].as_array().unwrap();
    let previous_by_path: IndexMap<_, _> = previous
        .and_then(|previous| previous["nodes"].as_array())
        .into_iter()
        .flatten()
        .map(|node| (node["path"].as_js_string().cloned(), node))
        .collect();
    let mut metrics: Metrics = nodes
        .iter()
        .map(|node| {
            (
                node["id"].as_js_string().unwrap().clone(),
                Mutable::new(
                    node,
                    previous_by_path
                        .get(&node["path"].as_js_string().cloned())
                        .copied(),
                ),
            )
        })
        .collect();
    let Some(revision) = snapshot["revision"].as_str() else {
        return checked(
            "gitGraphMetricsSchema",
            &json!({"analyzerVersion":1,"revision":Value::Null,"rootPath":snapshot["rootPath"],
            "historyScope":"none","renameAware":false,"blameCoverage":Value::Null,
            "nodes":nodes.iter().map(|node| Mutable::new(node,None).value(node,None)).collect::<Vec<_>>(),
            "analyzedAt":date(),"analysis":analysis(false,true,"unavailable")}),
        );
    };
    let root = snapshot["rootPath"].as_js_string();
    let root_text = root.map(JsString::lossy);
    let history_revision = previous
        .and_then(|previous| previous["revision"].as_str())
        .map_or_else(
            || revision.to_owned(),
            |previous| format!("{previous}..{revision}"),
        );
    let mut line_args = vec!["grep", "-I", "--count", "-z", "-e", "^", revision];
    let mut history_args = vec![
        "log",
        "--date=iso-strict",
        "--format=%x1e%H%x00%aI%x00",
        "--numstat",
        "-z",
        "--no-renames",
        &history_revision,
    ];
    if let Some(root) = root_text.as_deref() {
        line_args.extend(["--", root]);
        history_args.extend(["--", root]);
    }
    let (lines, changes) = tokio::join!(
        raw(cwd, &line_args, scope, true),
        raw(cwd, &history_args, scope, true)
    );
    let lines = counts(&lines?, revision);
    let changes = changes?;
    let mut paths = IndexMap::new();
    for node in nodes {
        let Some(path) = node["path"].as_js_string() else {
            continue;
        };
        paths.insert(path.clone(), node["id"].as_js_string().unwrap().clone());
        if node["kind"] != "file" {
            continue;
        }
        let metrics = metrics.get_mut(node["id"].as_js_string().unwrap()).unwrap();
        if let Some(lines) = lines.get(path) {
            metrics.lines = Some(*lines);
            metrics.binary = Some(false);
        } else if node["byteSize"].as_u64().unwrap_or(0) == 0 {
            metrics.lines = Some(0);
            metrics.binary = Some(false);
        } else {
            metrics.lines = None;
            metrics.binary = Some(true);
        }
    }
    for node in nodes.iter().rev() {
        let Some(parent) = node["parentId"].as_js_string() else {
            continue;
        };
        let lines = metrics[node["id"].as_js_string().unwrap()].lines;
        if let Some(lines) = lines
            && let Some(parent) = metrics.get_mut(parent)
        {
            parent.lines = Some(parent.lines.unwrap_or(0) + lines);
        }
    }
    history(&changes, root, &mut metrics, &paths);
    let (blame, coverage) = if include_blame {
        blame(cwd, snapshot, &metrics, scope).await?
    } else {
        (IndexMap::new(), Value::Null)
    };
    let state = if !include_blame {
        "deferred"
    } else if coverage["totalFiles"].as_u64().unwrap_or(0) > 0 {
        "ready"
    } else {
        "unavailable"
    };
    checked(
        "gitGraphMetricsSchema",
        &json!({"analyzerVersion":1,"revision":revision,"rootPath":root,"historyScope":"current-branch",
        "renameAware":false,"blameCoverage":coverage,"nodes":nodes.iter().map(|node| {
            let id=node["id"].as_js_string().unwrap();
            metrics[id].value(node,blame.get(id))
        }).collect::<Vec<_>>(),"analyzedAt":date(),"analysis":analysis(true,true,state)}),
    )
}
pub(in super::super) async fn metrics(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let snapshot = snapshot(cwd, command, scope).await?;
    let directory = common(cwd, scope).await?;
    let limit = command["maxNodes"].as_u64().unwrap_or(100_000);
    let include_blame = command["includeBlame"] == true;
    let scope_key = json!((1, directory, &snapshot["rootPath"], limit)).stringify();
    let key = json!((&scope_key, &snapshot["revision"], include_blame)).stringify();
    let cwd = cwd.to_owned();
    let owned_scope = scope.clone();
    cache::value(&cache::METRICS, key, scope, async move {
        let latest = cache::latest(&scope_key);
        let paths: IndexSet<_> = snapshot["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["path"].as_js_string().cloned())
            .collect();
        let previous = if let Some(latest) = latest {
            let latest_nodes = latest["nodes"].as_array().unwrap();
            let same = latest_nodes.len() == snapshot["nodes"].as_array().unwrap().len()
                && latest_nodes
                    .iter()
                    .all(|node| paths.contains(&node["path"].as_js_string().cloned()));
            if same
                && let (Some(old), Some(new)) =
                    (latest["revision"].as_str(), snapshot["revision"].as_str())
            {
                let ancestor = if old == new {
                    true
                } else {
                    let output = process::capture_limit(
                        &cwd,
                        &["merge-base", "--is-ancestor", old, new],
                        &owned_scope,
                        128 * 1024 * 1024,
                    )
                    .await?;
                    if output.overflow || !matches!(output.code, Some(0 | 1)) {
                        bail!("{}", output.error);
                    }
                    output.code == Some(0)
                };
                ancestor.then_some(latest)
            } else {
                None
            }
        } else {
            None
        };
        let result = create(
            &cwd,
            &snapshot,
            include_blame,
            previous.as_ref(),
            &owned_scope,
        )
        .await?;
        cache::publish(scope_key, &result);
        Ok(result)
    })
    .await
}
