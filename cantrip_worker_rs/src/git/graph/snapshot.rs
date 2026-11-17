use super::*;
struct Context {
    branch: Option<String>,
    common: JsString,
    revision: Option<String>,
    object: Option<String>,
    root: Option<JsString>,
}
async fn context(cwd: &Path, command: &Value, scope: &Scope) -> Result<Context> {
    let root = command["rootPath"].as_js_string().cloned();
    let revision = command["revision"]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| "HEAD".into())
        .trim();
    if revision.is_empty()
        || revision.units().len() > 1024
        || revision.units().first() == Some(&45)
        || revision
            .units()
            .iter()
            .any(|unit| [0, 10, 13].contains(unit))
    {
        bail!("Expected a safe Git graph revision.");
    }
    let common = common(cwd, scope).await?;
    let branch = text(cwd, &["branch", "--show-current"], scope)
        .await
        .unwrap_or_default();
    scope.check()?;
    let hash = text(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{}^{{commit}}", revision.lossy()),
        ],
        scope,
    )
    .await;
    scope.check()?;
    let revision = match hash {
        Ok(hash) => Some(hash),
        Err(_) if revision == JsString::from("HEAD") => None,
        Err(error) => return Err(error),
    };
    let object = if let Some(revision) = revision.as_ref() {
        let object = root.as_ref().map_or_else(
            || format!("{revision}^{{tree}}"),
            |root| format!("{revision}:{}", root.lossy()),
        );
        let kind = text(cwd, &["cat-file", "-t", &object], scope)
            .await
            .unwrap_or_default();
        scope.check()?;
        if kind != "tree" {
            return Err(root.as_ref().map_or_else(
                || anyhow::anyhow!("Git graph revision does not contain a tree."),
                |root| history::message("Git graph root is not a directory: ", root, ""),
            ));
        }
        Some(
            text(
                cwd,
                &["rev-parse", "--verify", "--end-of-options", &object],
                scope,
            )
            .await?,
        )
    } else {
        None
    };
    Ok(Context {
        branch: (!branch.is_empty()).then_some(branch),
        common,
        revision,
        object,
        root,
    })
}
fn extension(path: &JsString) -> Option<JsString> {
    let name = basename(path);
    let units = name.units();
    let dot = units.iter().rposition(|unit| *unit == 46)?;
    if dot == 0 || name == JsString::from("..") || dot + 1 == units.len() {
        return None;
    }
    Some(JsString::new(units[dot + 1..].to_vec()).lowercase())
}
fn language(path: &JsString) -> Option<JsString> {
    let name = basename(path).lowercase();
    let special = match name.as_str().unwrap_or("") {
        "dockerfile" => Some("Dockerfile"),
        "gemfile" => Some("Ruby"),
        "makefile" => Some("Makefile"),
        "procfile" => Some("Procfile"),
        _ => None,
    };
    if let Some(special) = special {
        return Some(special.into());
    }
    let extension = extension(&name)?;
    let known = match extension.as_str().unwrap_or("") {
        "c" => "C",
        "cc" | "cpp" => "C++",
        "cs" => "C#",
        "css" => "CSS",
        "dart" => "Dart",
        "go" => "Go",
        "h" => "C/C++ Header",
        "html" => "HTML",
        "java" => "Java",
        "js" | "jsx" => "JavaScript",
        "json" => "JSON",
        "kt" | "kts" => "Kotlin",
        "md" => "Markdown",
        "php" => "PHP",
        "py" => "Python",
        "rb" => "Ruby",
        "rs" => "Rust",
        "sh" => "Shell",
        "sql" => "SQL",
        "swift" => "Swift",
        "toml" => "TOML",
        "ts" | "tsx" => "TypeScript",
        "vue" => "Vue",
        "xml" => "XML",
        "yaml" | "yml" => "YAML",
        "zig" => "Zig",
        _ => return Some(extension.lossy().to_uppercase().into()),
    };
    Some(known.into())
}
fn inherited_language(path: &JsString) -> Option<&'static str> {
    // Source uses ordinary JS object lookups for both language dictionaries.
    // Preserve their inherited-key validation failures rather than silently
    // changing the result for files named constructor/__proto__.
    let name = basename(path).lowercase();
    let extension = extension(&name);
    for candidate in [Some(&name), extension.as_ref()].into_iter().flatten() {
        match candidate.as_str() {
            Some("constructor") => return Some("function"),
            Some("__proto__") => return Some("object"),
            _ => {}
        }
    }
    None
}
async fn create(cwd: &Path, context: Context, limit: usize, scope: &Scope) -> Result<Value> {
    let root = context.root.as_ref();
    let root_id = id("directory", root);
    let name = if let Some(root) = root {
        basename(root)
    } else {
        let canonical = paths::canonical(cwd).await?;
        canonical
            .file_name()
            .map(|name| paths::text(Path::new(name)))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Repository".into())
    };
    let mut nodes = vec![
        json!({"id":root_id,"path":root,"parentId":Value::Null,"name":name,"kind":"directory",
        "objectId":context.object,"byteSize":0,"extension":Value::Null,"language":Value::Null}),
    ];
    let mut total = 1usize;
    let mut inherited_languages = IndexMap::new();
    if let Some(revision) = context.revision.as_deref() {
        let root_text = root.map(JsString::lossy);
        let mut args = vec!["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", revision];
        if let Some(root) = root_text.as_deref() {
            args.extend(["--", root]);
        }
        let output = raw(cwd, &args, scope, false).await?;
        for record in output.split('\0').filter(|record| !record.is_empty()) {
            let Some((metadata, path)) = record.split_once('\t') else {
                continue;
            };
            let fields: Vec<_> = metadata.split_whitespace().collect();
            if fields.len() < 3 || path.is_empty() {
                continue;
            }
            let path = JsString::from(path);
            if !within(&path, root) || (root == Some(&path) && fields[1] == "tree") {
                continue;
            }
            total += 1;
            if nodes.len() >= limit {
                continue;
            }
            let kind = match (fields[0], fields[1]) {
                (_, "tree") => "directory",
                ("160000", _) | (_, "commit") => "submodule",
                ("120000", _) => "symlink",
                _ => "file",
            };
            let size = fields.get(3).and_then(|size| size.parse::<u64>().ok());
            let inherited = (kind == "file")
                .then(|| inherited_language(&path))
                .flatten();
            if let Some(inherited) = inherited {
                inherited_languages.insert(
                    nodes.len(),
                    if inherited == "function" {
                        "function"
                    } else {
                        "Object"
                    },
                );
            }
            let language = if inherited.is_some() {
                json!({})
            } else {
                json!(if kind == "file" {
                    language(&path)
                } else {
                    None
                })
            };
            nodes.push(json!({"id":id(kind,Some(&path)),"path":path,"parentId":id("directory",parent(&path,root).as_ref()),
                "name":basename(&path),"kind":kind,"objectId":fields[2],"byteSize":if kind=="directory"{Some(0)}else{size},
                "extension":if kind=="file"{extension(&path)}else{None},
                "language":language}));
        }
        let by_id: IndexMap<JsString, usize> = nodes
            .iter()
            .enumerate()
            .map(|(i, node)| (node["id"].as_js_string().unwrap().clone(), i))
            .collect();
        for i in (0..nodes.len()).rev() {
            let node = &nodes[i];
            if let (Some(parent), Some(size)) =
                (node["parentId"].as_js_string(), node["byteSize"].as_u64())
                && let Some(&parent) = by_id.get(parent)
                && nodes[parent]["kind"] == "directory"
            {
                let next = nodes[parent]["byteSize"].as_u64().unwrap_or(0) + size;
                nodes[parent]["byteSize"] = json!(next);
            }
        }
    }
    let present = context.revision.is_some();
    let output = json!({"analyzerVersion":1,"revision":context.revision,"branch":context.branch,
        "rootPath":context.root,"rootId":root_id,"totalNodes":total,"truncated":total>nodes.len(),"nodes":nodes,
        "analyzedAt":date(),"analysis":analysis(present,false,if present{"deferred"}else{"unavailable"})});
    match cantrip_protocol::parse("gitGraphSnapshotSchema", Some(&output)) {
        Err(cantrip_protocol::ValidationError::Invalid(mut issues)) => {
            for issue in &mut issues {
                if let Some(path) = issue["path"].as_array()
                    && path.len() == 3
                    && path[0] == "nodes"
                    && path[2] == "language"
                    && let Some(received) = path[1]
                        .as_u64()
                        .and_then(|i| inherited_languages.get(&(i as usize)))
                {
                    issue["message"] = json!(format!(
                        "Invalid input: expected string, received {received}"
                    ));
                }
            }
            Err(cantrip_protocol::response::response_error(
                cantrip_protocol::ValidationError::Invalid(issues),
            ))
        }
        result => result.map_err(cantrip_protocol::response::response_error),
    }
}
pub(in super::super) async fn snapshot(
    cwd: &Path,
    command: &Value,
    scope: &Scope,
) -> Result<Value> {
    let limit = command["maxNodes"].as_u64().unwrap_or(100_000) as usize;
    if !(1..=100_000).contains(&limit) {
        bail!("Git graph maxNodes must be between 1 and 100000.");
    }
    let context = context(cwd, command, scope).await?;
    let key = json!((
        1,
        &context.common,
        &context.revision,
        &context.branch,
        &context.root,
        limit
    ))
    .stringify();
    let owned_scope = scope.clone();
    let cwd = cwd.to_owned();
    cache::value(&cache::SNAPSHOTS, key, scope, async move {
        create(&cwd, context, limit, &owned_scope).await
    })
    .await
}
