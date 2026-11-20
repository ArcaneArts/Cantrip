//! Discover HTTP services reachable at listening addresses on the worker host.
use crate::{filesystem::Scope, http::checked};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value, text::whitespace, value::json};
use futures::{StreamExt, stream};
use icu_collator::{Collator, options::CollatorOptions};
use indexmap::IndexMap;
use regex::Regex;
use reqwest::{Client, Url, redirect::Policy};
use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    net::IpAddr,
    path::Path,
    sync::LazyLock,
    time::Duration,
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_COMMAND_BYTES: usize = 4 * 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_millis(750);
const MAX_CANDIDATES: usize = 128;
const PROBE_CONCURRENCY: usize = 24;
const MAX_TITLE_UNITS: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Listener {
    pub(crate) host: String,
    pub(crate) port: u16,
    pid: Option<u32>,
    executable: Option<String>,
}

impl Listener {
    fn parse(address: &str, pid: Option<u32>, executable: Option<&str>) -> Option<Self> {
        let address = address.trim().trim_end_matches(" (LISTEN)");
        let (host, port) = address.rsplit_once(':')?;
        let host = host.trim().strip_prefix("TCP ").unwrap_or(host.trim());
        let host = match host {
            "*" | "0.0.0.0" => "127.0.0.1",
            "::" | "[::]" => "::1",
            host => host
                .strip_prefix('[')
                .and_then(|host| host.strip_suffix(']'))
                .unwrap_or(host),
        };
        let port = port.parse::<u16>().ok().filter(|&port| port > 0)?;
        // The native commands below request numeric local addresses.
        host.parse::<IpAddr>().ok()?;
        Some(Self {
            host: host.to_owned(),
            port,
            pid,
            executable: executable.map(str::to_owned),
        })
    }

    fn url(&self, protocol: &str) -> String {
        if self.host.contains(':') {
            format!("{protocol}://[{}]:{}/", self.host, self.port)
        } else {
            format!("{protocol}://{}:{}/", self.host, self.port)
        }
    }
}

fn pid(text: &str) -> Option<u32> {
    text.trim().parse::<u32>().ok().filter(|&pid| pid > 0)
}

fn lsof_listeners(text: &str) -> Vec<Listener> {
    let mut process = None;
    let mut executable = None;
    let mut listeners = Vec::new();
    for line in text.lines() {
        match line.as_bytes().first() {
            Some(b'p') => {
                process = pid(&line[1..]);
                executable = None;
            }
            Some(b'c') => {
                let name = line[1..].trim();
                executable = (!name.is_empty()).then_some(name);
            }
            Some(b'n') => listeners.extend(Listener::parse(&line[1..], process, executable)),
            _ => {}
        }
    }
    listeners
}

fn ss_listeners(text: &str) -> Vec<Listener> {
    static PROCESS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"\(\("([^"]+)",pid=(\d+)"#).unwrap());
    text.lines()
        .filter_map(|line| {
            let address = line.split_whitespace().nth(3)?;
            let process = PROCESS.captures(line);
            Listener::parse(
                address,
                process
                    .as_ref()
                    .and_then(|matched| pid(matched.get(2)?.as_str())),
                process
                    .as_ref()
                    .and_then(|matched| matched.get(1))
                    .map(|name| name.as_str()),
            )
        })
        .collect()
}

fn netstat_listeners(text: &str) -> Vec<Listener> {
    text.lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let protocol = columns.next()?;
            let address = columns.next()?;
            columns.next()?;
            let process = columns.next_back()?;
            let state = columns.next_back()?;
            if protocol.eq_ignore_ascii_case("tcp") && state.eq_ignore_ascii_case("listening") {
                Listener::parse(address, pid(process), None)
            } else {
                None
            }
        })
        .collect()
}

async fn output(scope: &Scope, command: &str, arguments: &[&str]) -> Result<String> {
    let arguments = arguments.iter().map(OsString::from).collect::<Vec<_>>();
    let capture = scope
        .capture_timeout(
            OsStr::new(command),
            &arguments,
            MAX_COMMAND_BYTES,
            COMMAND_TIMEOUT,
        )
        .await;
    scope.check()?;
    Ok(match capture {
        Ok(output) if output.code == Some(0) && output.overflow.is_none() && !output.timed_out => {
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
        _ => String::new(),
    })
}

pub(crate) async fn listeners(scope: &Scope) -> Result<Vec<Listener>> {
    let platform = std::env::consts::OS;
    let candidates = if platform == "windows" {
        netstat_listeners(&output(scope, "netstat", &["-ano", "-p", "tcp"]).await?)
    } else {
        let mut found = lsof_listeners(
            &output(scope, "lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]).await?,
        );
        if found.is_empty() && platform == "linux" {
            found = ss_listeners(&output(scope, "ss", &["-H", "-ltnp"]).await?);
        }
        found
    };
    let mut unique = IndexMap::<_, Listener>::new();
    for candidate in candidates {
        unique
            .entry((candidate.host.clone(), candidate.port))
            .and_modify(|previous| {
                if previous.pid.is_none() && candidate.pid.is_some() {
                    previous.pid = candidate.pid;
                    previous.executable.clone_from(&candidate.executable);
                }
            })
            .or_insert(candidate);
    }
    let mut candidates = unique.into_values().collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| candidate.port);
    candidates.truncate(MAX_CANDIDATES);
    Ok(candidates)
}

async fn process_commands(scope: &Scope, candidates: &[Listener]) -> Result<HashMap<u32, String>> {
    let mut seen = HashSet::new();
    let processes = candidates
        .iter()
        .filter_map(|candidate| candidate.pid)
        .filter(|pid| seen.insert(*pid))
        .map(|pid| pid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    if processes.is_empty() || cfg!(windows) {
        return Ok(HashMap::new());
    }
    let listing = output(
        scope,
        "ps",
        &["-p", &processes, "-o", "pid=", "-o", "command="],
    )
    .await?;
    Ok(listing
        .lines()
        .filter_map(|line| {
            let (process, command) = line.trim_start().split_once(char::is_whitespace)?;
            Some((pid(process)?, command.trim_start().to_owned()))
        })
        .collect())
}

fn process_label(command: Option<&str>, executable: Option<&str>) -> Option<JsString> {
    static KNOWN: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
        [
            (r"(?:^|[\s/\\])vite(?:\.js)?(?:$|[\s/\\])", "Vite"),
            (r"(?:^|[\s/\\])next(?:\.js)?(?:$|[\s/\\])", "Next.js"),
            (r"(?:^|[\s/\\])nuxt(?:$|[\s/\\])", "Nuxt"),
            (r"(?:^|[\s/\\])astro(?:$|[\s/\\])", "Astro"),
            (r"webpack(?:-dev-server)?", "Webpack"),
            (r"ng serve|angular-cli", "Angular"),
            (r"react-scripts|react-router dev", "React"),
            (r"(?:^|[\s/\\])remix(?:$|[\s/\\])", "Remix"),
            (r"svelte-kit|sveltekit", "SvelteKit"),
            (r"vue-cli-service|vue dev", "Vue"),
            (r"django|manage\.py runserver", "Django"),
            (r"flask|werkzeug", "Flask"),
            (r"uvicorn", "Uvicorn"),
            (r"gunicorn", "Gunicorn"),
            (r"rails server|puma", "Rails"),
            (r"php artisan serve|laravel", "Laravel"),
        ]
        .into_iter()
        .map(|(pattern, name)| (Regex::new(pattern).unwrap(), name))
        .collect()
    });
    let text = format!(
        "{} {}",
        command.unwrap_or_default(),
        executable.unwrap_or_default()
    )
    .to_lowercase();
    if let Some((_, name)) = KNOWN.iter().find(|(pattern, _)| pattern.is_match(&text)) {
        return Some((*name).into());
    }
    let name = Path::new(executable?).file_name()?.to_str()?;
    let name = if name.to_ascii_lowercase().ends_with(".exe") {
        &name[..name.len() - 4]
    } else {
        name
    }
    .trim_matches(whitespace);
    static PYTHON: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^python[0-9]*(?:\.[0-9]+)?$").unwrap());
    let lowercase = name.to_ascii_lowercase();
    let label = match lowercase.as_str() {
        "node" | "nodejs" => "Node.js",
        "ruby" => "Ruby",
        "java" => "Java",
        "bun" => "Bun",
        "deno" => "Deno",
        "php" => "PHP",
        lowercase if PYTHON.is_match(lowercase) => "Python",
        _ => name,
    };
    limited_label(label)
}

fn limited_label(text: &str) -> Option<JsString> {
    let units = text.encode_utf16().take(200).collect::<Vec<_>>();
    (!units.is_empty()).then(|| JsString::new(units))
}

fn title(body: &str) -> Option<JsString> {
    static TITLE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?is)<title(?:\s[^>]*)?>(.*?)</title>").unwrap());
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    static ENTITIES: LazyLock<[(Regex, &str); 5]> = LazyLock::new(|| {
        [
            ("(?i)&amp;", "&"),
            ("(?i)&lt;", "<"),
            ("(?i)&gt;", ">"),
            ("(?i)&quot;", "\""),
            ("(?i)&#(?:39|x27);", "'"),
        ]
        .map(|(pattern, text)| (Regex::new(pattern).unwrap(), text))
    });
    let raw = TITLE.captures(body)?.get(1)?.as_str();
    let mut clean = TAG.replace_all(raw, " ").into_owned();
    for (pattern, replace) in ENTITIES.iter() {
        if let std::borrow::Cow::Owned(unescaped) = pattern.replace_all(&clean, *replace) {
            clean = unescaped;
        }
    }
    let normalized = clean
        .split(whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    limited_label(&normalized)
}

fn client() -> Result<Client> {
    Ok(Client::builder()
        .http1_only()
        .no_proxy()
        .redirect(Policy::none())
        .no_gzip()
        .no_deflate()
        .no_brotli()
        .no_zstd()
        // A discovery request carries no credentials and goes only to
        // a numeric listener from the operating system. Self-signed HTTPS
        // is common for development services on the worker host.
        .tls_danger_accept_invalid_certs(true)
        .tls_danger_accept_invalid_hostnames(true)
        .build()?)
}

async fn probe_http(client: &Client, url: Url) -> Option<(u16, Option<JsString>)> {
    tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut response = client
            .get(url)
            .header("Accept", "text/html,application/json,text/plain,*/*;q=0.5")
            .header("User-Agent", "Cantrip-Service-Discovery/1.0")
            .send()
            .await
            .ok()?;
        let status = response.status().as_u16();
        if !(100..=599).contains(&status) {
            return None;
        }
        // Node's streaming UTF-8 decoder bounds the title sample in UTF-16 units.
        let mut decoder = encoding_rs::UTF_8.new_decoder_without_bom_handling();
        let mut sample = vec![0; MAX_TITLE_UNITS + 1];
        let mut length = 0;
        while let Ok(Some(chunk)) = response.chunk().await {
            let (progress, _, written, _) =
                decoder.decode_to_utf16(&chunk, &mut sample[length..], false);
            length += written;
            if progress == encoding_rs::CoderResult::OutputFull || length >= MAX_TITLE_UNITS {
                break;
            }
        }
        if length < MAX_TITLE_UNITS {
            let (_, _, written, _) = decoder.decode_to_utf16(&[], &mut sample[length..], true);
            length += written;
        }
        let sample = String::from_utf16_lossy(&sample[..length.min(MAX_TITLE_UNITS)]);
        Some((status, title(&sample)))
    })
    .await
    .ok()
    .flatten()
}

async fn probe(
    client: &Client,
    worker: &JsString,
    candidate: &Listener,
    command: Option<&str>,
) -> Option<Value> {
    for protocol in ["http", "https"] {
        let address = candidate.url(protocol);
        let url = Url::parse(&address).ok()?;
        if let Some((status, title)) = probe_http(client, url).await {
            return Some(json!({
                "workerId":worker,
                "host":candidate.host,
                "port":candidate.port,
                "protocol":protocol,
                "url":address,
                "title":title,
                "processName":process_label(command, candidate.executable.as_deref()),
                "statusCode":status
            }));
        }
    }
    None
}

pub(crate) async fn discover(worker: &JsString, scope: &Scope) -> Result<Value> {
    let listeners = listeners(scope).await?;
    let processes = process_commands(scope, &listeners).await?;
    let client = client()?;
    let captures = stream::iter(listeners)
        .map(|candidate| {
            let (client, processes) = (&client, &processes);
            async move {
                let command = candidate
                    .pid
                    .and_then(|pid| processes.get(&pid))
                    .map(String::as_str);
                probe(client, worker, &candidate, command).await
            }
        })
        .buffer_unordered(PROBE_CONCURRENCY)
        .filter_map(std::future::ready)
        .collect::<Vec<_>>();
    let mut services = tokio::select! {
        values = captures => values,
        _ = scope.stopped() => return Err(anyhow!("Browser service discovery stopped.")),
    };
    let locale = cantrip_wire::environment::locale()
        .unwrap_or("en-US")
        .parse::<icu_locale_core::Locale>()
        .unwrap_or_else(|_| "en-US".parse().unwrap());
    let collator = Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|error| anyhow!("Browser service sorting locale: {error}"))?;
    services.sort_by(|a, b| {
        a["port"].as_u64().cmp(&b["port"].as_u64()).then_with(|| {
            collator.compare_utf16(
                a["url"].as_js_string().unwrap().units(),
                b["url"].as_js_string().unwrap().units(),
            )
        })
    });
    checked("browserServiceListSchema", &Value::Array(services))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_listener_formats_keep_addresses_and_process_identity() {
        let mac = lsof_listeners(
            "p321\r\ncnode\r\nnTCP *:5173 (LISTEN)\r\np322\nn[::]:4173\nn127.0.0.1:0\n",
        );
        assert_eq!(mac.len(), 2);
        assert_eq!(
            mac[0],
            Listener::parse("127.0.0.1:5173", Some(321), Some("node")).unwrap()
        );
        assert_eq!(
            mac[1],
            Listener::parse("[::1]:4173", Some(322), None).unwrap()
        );
        assert_eq!(mac[1].url("https"), "https://[::1]:4173/");
        let linux =
            ss_listeners("LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:((\"node\",pid=77,fd=20))");
        assert_eq!(
            linux,
            vec![Listener::parse("127.0.0.1:3000", Some(77), Some("node")).unwrap()]
        );
        let windows = netstat_listeners(
            "TCP 0.0.0.0:8080 0.0.0.0:0 LISTENING 991\nTCP 127.0.0.1:9000 127.0.0.1:80 TIME_WAIT 0",
        );
        assert_eq!(
            windows,
            vec![Listener::parse("127.0.0.1:8080", Some(991), None).unwrap()]
        );
    }

    #[test]
    fn labels_use_the_existing_title_decoding_and_utf16_limit() {
        assert_eq!(
            title("<TITLE data-short> A &amp;lt; <em>B</em> &#X27; 🧪 </TITLE>"),
            Some("A < B ' 🧪".into())
        );
        assert_eq!(
            title("<title>&#39; &QUOT; &gt;</title>"),
            Some("' \" >".into())
        );
        let joined = format!("<title>{}🧪tail</title>", "a".repeat(199));
        let bounded = title(&joined).unwrap();
        assert_eq!(bounded.len(), 200);
        assert_eq!(bounded.units()[199], 0xd83e);
        assert_eq!(
            process_label(Some("node C:\\workspace\\vite\\bin\\vite.js"), Some("node")),
            Some("Vite".into())
        );
        assert_eq!(
            process_label(Some("python -m uvicorn main:app"), Some("python3")),
            Some("Uvicorn".into())
        );
        assert_eq!(
            process_label(None, Some("Node.EXE")),
            Some("Node.js".into())
        );
    }
}
