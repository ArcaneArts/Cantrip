mod network;
mod render;
mod robots;
mod search;
pub(crate) mod session;

use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use cantrip_protocol::{date_iso_milliseconds, mcp_host, response::response_error};
use cantrip_wire::{JsString, Value, text, value::json};
use dom_smoothie::{Config, Readability};
use indexmap::IndexMap;
use network::{Limits, Network, Page, follow, normalize};
use robots::Robots;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::Semaphore,
    time::{Instant, timeout},
};
use url::Url;

const MAX_CHARS: usize = 1_000_000;
const CURSOR_TTL: Duration = Duration::from_secs(600);
const RATE_WINDOW: Duration = Duration::from_secs(60);
const PAGE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_CURSORS: usize = 100;
const LIMITS: Limits = Limits {
    compressed: 5_000_000,
    expanded: 10_000_000,
    types: &[
        "application/xhtml+xml",
        "text/html",
        "text/markdown",
        "text/plain",
        "text/x-markdown",
    ],
};

type Scope = (JsString, JsString);

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
enum Operation {
    Read,
    Search,
}

impl Operation {
    fn limit(self) -> (&'static str, u32) {
        match self {
            Self::Read => ("read", 60),
            Self::Search => ("search", 30),
        }
    }
}

fn scope(binding: &Value) -> Result<Scope> {
    Ok((
        binding["ownerId"]
            .as_js_string()
            .context("Missing MCP owner.")?
            .clone(),
        binding["chatId"]
            .as_js_string()
            .context("Missing MCP chat.")?
            .clone(),
    ))
}

#[derive(Default)]
struct State {
    windows: HashMap<(Scope, Operation), Window>,
    references: IndexMap<String, search::Reference>,
    cursors: IndexMap<String, Continuation>,
}

struct Window {
    count: u32,
    expires: Instant,
    retry_at: i64,
}

struct Continuation {
    scope: Scope,
    expires: Instant,
    document: Arc<Document>,
    offset: usize,
}

struct Document {
    url: String,
    title: JsString,
    content: JsString,
    method: &'static str,
    retrieved_at: String,
}

pub(crate) struct Service {
    state: Mutex<State>,
    sessions: session::Sessions,
    visible: session::Visible,
    browser_surfaces: Option<Arc<crate::browser_surface::Manager>>,
    network: Network,
    robots: Robots,
    extraction: Arc<Semaphore>,
    renderer: Option<Arc<crate::managed_web::Manager>>,
    search: Option<Arc<crate::managed_web::Search>>,
    render_slots: Semaphore,
    render_requests: Semaphore,
    render_assets: Semaphore,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
            sessions: session::Sessions::default(),
            visible: session::Visible::default(),
            browser_surfaces: None,
            network: Network::default(),
            robots: Robots::default(),
            extraction: Arc::new(Semaphore::new(2)),
            renderer: None,
            search: None,
            render_slots: Semaphore::new(4),
            render_requests: Semaphore::new(20),
            render_assets: Semaphore::new(8),
        }
    }
}

impl Service {
    #[cfg(test)]
    pub(crate) fn with_fixture(
        renderer: Option<Arc<crate::managed_web::Manager>>,
        search: Option<Arc<crate::managed_web::Search>>,
        address: std::net::SocketAddr,
    ) -> Arc<Self> {
        let mut service = Self::new(renderer, search);
        service.network.fixture = Some(address);
        Arc::new(service)
    }

    pub(crate) fn new(
        renderer: Option<Arc<crate::managed_web::Manager>>,
        search: Option<Arc<crate::managed_web::Search>>,
    ) -> Self {
        Self {
            renderer,
            search,
            ..Self::default()
        }
    }

    pub(crate) fn with_browser_surfaces(
        mut self,
        surfaces: Option<Arc<crate::browser_surface::Manager>>,
    ) -> Self {
        self.browser_surfaces = surfaces;
        self
    }

    pub(crate) async fn read(
        self: &Arc<Self>,
        binding: &Value,
        args: Option<&Value>,
    ) -> Result<Value> {
        let args = mcp_host::parse("mcpStdioInput/web_read", args).map_err(response_error)?;
        let scope = scope(binding)?;
        self.consume(&scope, Operation::Read)?;
        let maximum = args["maxChars"].as_u64().unwrap() as usize;
        if let Some(id) = args["cursor"].as_str() {
            let cursor = self.take_cursor(&scope, id)?;
            return self.page(scope, cursor.document, cursor.offset, maximum);
        }
        let url = match args["searchResultId"].as_str() {
            Some(id) => self.search_url(&scope, id)?,
            None => normalize(Url::parse(&args["url"].as_js_string().unwrap().lossy())?)?,
        };
        let render = args["render"].as_str().unwrap();
        if render == "always" {
            self.robots.check(&self.network, &url).await?;
            let document = self.render(url).await?;
            return self.page(scope, Arc::new(document), 0, maximum);
        }
        let page = timeout(
            PAGE_TIMEOUT,
            follow(url, |candidate| async move {
                self.robots.check(&self.network, &candidate).await?;
                self.network.get(candidate, &LIMITS).await
            }),
        )
        .await
        .context("Web read request timed out.")??;
        ensure!(
            (200..300).contains(&page.status),
            "Web read returned HTTP {}.",
            page.status
        );
        let final_url = page.url.clone();
        let document = self.extract(page).await?;
        let document = if render == "auto" && document.content.units().len() < 100 {
            self.render(final_url).await?
        } else {
            document
        };
        self.page(scope, Arc::new(document), 0, maximum)
    }

    async fn extract(&self, page: Page) -> Result<Document> {
        let budget = self.extraction.clone().acquire_owned().await?;
        tokio::task::spawn_blocking(move || {
            let _budget = budget;
            document(page)
        })
        .await?
    }

    async fn render(self: &Arc<Self>, url: Url) -> Result<Document> {
        let manager = self
            .renderer
            .clone()
            .context("Rendered reading is unavailable on this worker.")?;
        let owner = self.clone();
        let (keep_running, cancelled) = tokio::sync::oneshot::channel::<()>();
        let task =
            tokio::spawn(async move { render::managed(owner, manager, url, cancelled).await });
        let result = task.await?;
        drop(keep_running);
        let rendered = result?;
        let mut document = self
            .extract(Page {
                url: rendered.url,
                bytes: rendered.html.into_bytes(),
                content_type: "text/html".into(),
                charset: None,
                status: 200,
            })
            .await?;
        ensure!(
            !document.content.is_empty(),
            "Rendered reading found no usable page content."
        );
        if document.title.is_empty() {
            document.title = compact(&rendered.title, 1_000);
        }
        document.method = "rendered";
        Ok(document)
    }

    fn consume(&self, scope: &Scope, operation: Operation) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let now = Instant::now();
        state.windows.retain(|_, window| window.expires > now);
        state.cursors.retain(|_, cursor| cursor.expires > now);
        state
            .references
            .retain(|_, reference| reference.expires > now);
        let window = state
            .windows
            .entry((scope.clone(), operation))
            .or_insert_with(|| Window {
                count: 0,
                expires: now + RATE_WINDOW,
                retry_at: chrono::Utc::now().timestamp_millis() + RATE_WINDOW.as_millis() as i64,
            });
        let (name, limit) = operation.limit();
        if window.count >= limit {
            let retry =
                date_iso_milliseconds(window.retry_at).context("Invalid retry timestamp.")?;
            bail!("Web {name} rate limit reached. Retry after {retry}.");
        }
        window.count += 1;
        Ok(())
    }

    fn take_cursor(&self, scope: &Scope, id: &str) -> Result<Continuation> {
        let mut state = self.state.lock().unwrap();
        ensure!(
            state
                .cursors
                .get(id)
                .is_some_and(|cursor| cursor.scope == *scope),
            "Web read cursor is expired or belongs to another task."
        );
        Ok(state.cursors.shift_remove(id).unwrap())
    }

    fn page(
        &self,
        scope: Scope,
        document: Arc<Document>,
        offset: usize,
        maximum: usize,
    ) -> Result<Value> {
        let count = document.content.units().len();
        let next = offset.saturating_add(maximum).min(count);
        let truncated = next < count;
        let content = JsString::new(document.content.units()[offset..next].to_vec());
        let cursor = if truncated {
            let id = opaque("wrc")?;
            let mut state = self.state.lock().unwrap();
            state.cursors.insert(
                id.clone(),
                Continuation {
                    scope,
                    expires: Instant::now() + CURSOR_TTL,
                    document: document.clone(),
                    offset: next,
                },
            );
            if state.cursors.len() > MAX_CURSORS {
                state.cursors.shift_remove_index(0);
            }
            json!(id)
        } else {
            Value::Null
        };
        let length = next - offset;
        let plural = if length == 1 { "" } else { "s" };
        let more = if truncated {
            "; more content is available"
        } else {
            ""
        };
        let result = json!({
            "summary":format!("Read {length} character{plural}{more}."),
            "target":Value::Null, "worktreeId":Value::Null, "continuationScheduled":false, "mutated":false,
            "data":json!({
                "url":document.url, "title":document.title, "content":content,
                "method":document.method, "retrievedAt":document.retrieved_at,
                "cursor":cursor, "truncated":truncated,
            }),
        });
        mcp_host::parse("mcpStdioOutput/web_read", Some(&result)).map_err(response_error)
    }
}

fn opaque(prefix: &str) -> Result<String> {
    let mut random = [0; 24];
    getrandom::fill(&mut random).map_err(|_| anyhow!("Could not generate a web reference."))?;
    Ok(format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(random)))
}

fn compact(contents: &str, limit: usize) -> JsString {
    compact_chars(contents.chars().map(Ok), limit)
}

fn compact_chars(
    contents: impl Iterator<Item = std::result::Result<char, u16>>,
    limit: usize,
) -> JsString {
    let mut units = Vec::new();
    let mut space = false;
    for value in contents {
        if matches!(
            value,
            Ok('\0'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' | '\u{7f}')
        ) {
            continue;
        }
        if value.is_ok_and(text::whitespace) {
            space = !units.is_empty();
            continue;
        }
        if space {
            units.push(u16::from(b' '));
            space = false;
        }
        match value {
            Ok(ch) => units.extend_from_slice(ch.encode_utf16(&mut [0; 2])),
            Err(unit) => units.push(unit),
        }
        if units.len() >= limit {
            units.truncate(limit);
            break;
        }
    }
    JsString::new(units)
}

fn document(page: Page) -> Result<Document> {
    let encoding = page
        .charset
        .as_deref()
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (body, _) = encoding.decode_with_bom_removal(&page.bytes);
    let retrieved_at = date_iso_milliseconds(chrono::Utc::now().timestamp_millis())
        .context("Invalid web retrieval timestamp.")?;
    if !matches!(
        page.content_type.as_str(),
        "text/html" | "application/xhtml+xml"
    ) {
        return Ok(Document {
            url: page.url.into(),
            title: JsString::from(""),
            content: compact(&body, MAX_CHARS),
            method: "plain-text",
            retrieved_at,
        });
    }

    let mut reader = Readability::new(
        body.as_ref(),
        Some(page.url.as_str()),
        Some(Config {
            char_threshold: 100,
            max_elements_to_parse: 100_000,
            ..Config::default()
        }),
    )?;
    let article = match reader.parse() {
        Ok(article) => Some(article),
        Err(dom_smoothie::ReadabilityError::TooManyElements(..)) => {
            bail!("Web read exceeded the HTML element limit.");
        }
        Err(_) => None,
    };
    let canonical = reader
        .doc
        .select_single("link[rel~='canonical']")
        .attr("href")
        .filter(|href| !href.is_empty())
        .and_then(|href| page.url.join(&href).ok())
        .and_then(|url| normalize(url).ok())
        .unwrap_or(page.url);
    let (title, content) = if let Some(article) = article {
        (
            compact(&article.title, 1_000),
            compact(&article.text_content, MAX_CHARS),
        )
    } else {
        let title = reader.doc.select_single("title").text();
        let body = reader.doc.select_single("body").text();
        (compact(&title, 1_000), compact(&body, MAX_CHARS))
    };
    Ok(Document {
        url: canonical.into(),
        title,
        content,
        method: "static",
        retrieved_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Full;
    use hyper::{Request, Response, body::Incoming, server::conn::http1, service::service_fn};
    use hyper_util::rt::TokioIo;
    use std::{convert::Infallible, io::Write, net::Ipv4Addr};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn static_reader_follows_public_hops_checks_robots_and_pages_utf16() -> Result<()> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        let fixture = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(socket), service_fn(serve))
                        .await;
                });
            }
        });
        let mut service = Service::default();
        service.network.fixture = Some(address);
        let service = Arc::new(service);
        let binding = json!({"ownerId":"owner","chatId":"chat"});
        let attempt =
            |path: &str| json!({"url":format!("http://docs.example{path}"),"render":"never"});
        let initial = service.read(&binding, Some(&attempt("/start"))).await?;
        assert_eq!(initial["data"]["url"], "http://articles.example/canonical");
        assert_eq!(initial["data"]["title"], "Fixture article");
        assert_eq!(initial["data"]["method"], "static");
        let prose = "This useful article stays readable while the surrounding script is removed. "
            .repeat(5);
        assert_eq!(initial["data"]["content"], prose.trim());

        let paged = json!({"url":"http://docs.example/plain","maxChars":1000});
        let first = service.read(&binding, Some(&paged)).await?;
        let first = &first["data"];
        assert_eq!(first["method"], "plain-text");
        assert_eq!(first["title"], "");
        assert_eq!(first["truncated"], true);
        let units = first["content"].as_js_string().unwrap().units();
        assert_eq!(units.len(), 1000);
        assert_eq!(units[999], 0xd83d);
        let continuation = json!({"cursor":first["cursor"],"maxChars":1000});
        assert!(
            service
                .read(
                    &json!({"ownerId":"owner","chatId":"other"}),
                    Some(&continuation)
                )
                .await
                .unwrap_err()
                .to_string()
                .contains("another task")
        );
        let next = service.read(&binding, Some(&continuation)).await?;
        assert_eq!(
            next["data"]["content"].as_js_string().unwrap().units(),
            &[0xde00, 0x20, 0x20ac]
        );
        assert_eq!(next["data"]["cursor"], Value::Null);
        assert_eq!(next["data"]["retrievedAt"], first["retrievedAt"]);
        assert!(service.read(&binding, Some(&continuation)).await.is_err());

        for (path, message) in [
            ("/blocked-hop", "robots policy"),
            ("/local-hop", "local or private addresses"),
            ("/loop", "redirect limit"),
            ("/binary", "content type application/octet-stream"),
        ] {
            let error = service
                .read(&binding, Some(&attempt(path)))
                .await
                .unwrap_err();
            assert!(error.to_string().contains(message), "{error}");
        }
        let legacy = service.read(&binding, Some(&attempt("/legacy"))).await?;
        assert_eq!(legacy["data"]["content"], "A € page");
        let auto = json!({"url":"http://docs.example/short"});
        assert!(
            service
                .read(&binding, Some(&auto))
                .await
                .unwrap_err()
                .to_string()
                .contains("Rendered reading is unavailable")
        );
        fixture.abort();
        Ok(())
    }

    async fn serve(request: Request<Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
        let host = request.headers()["host"].to_str().unwrap();
        let path = request.uri().path();
        let mut response = Response::builder().header("content-type", "text/plain");
        let body = match (host, path) {
            ("articles.example", "/robots.txt") => {
                b"User-agent: CantripResearchBot\nDisallow: /blocked$\n".to_vec()
            }
            (_, "/robots.txt") => b"User-agent: *\n".to_vec(),
            (_, "/start") | (_, "/blocked-hop") | (_, "/local-hop") | (_, "/loop") => {
                let location = match path {
                    "/start" => "http://articles.example/article",
                    "/blocked-hop" => "http://articles.example/blocked",
                    "/local-hop" => "http://127.0.0.1/",
                    _ => "/loop",
                };
                response = response.status(302).header("location", location);
                Vec::new()
            }
            (_, "/binary") => {
                return Ok(Response::builder()
                    .header("content-type", "application/octet-stream")
                    .body(Full::new(Bytes::from_static(b"binary")))
                    .unwrap());
            }
            (_, "/article") => {
                let html = format!(
                    r#"<html><head><title>Fixture article</title><link rel="canonical" href="/canonical"></head><body><script>excluded script</script><article><p>{}</p></article></body></html>"#,
                    "This useful article stays readable while the surrounding script is removed. "
                        .repeat(5),
                );
                return Ok(Response::builder()
                    .header("content-type", "text/html")
                    .body(Full::new(Bytes::from(html)))
                    .unwrap());
            }
            (_, "/plain") => {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
                let prose = format!(" \t{}😀\r\n€ \0", "a".repeat(999));
                encoder.write_all(prose.as_bytes()).unwrap();
                response = response.header("content-encoding", "gzip");
                encoder.finish().unwrap()
            }
            (_, "/legacy") => {
                return Ok(Response::builder()
                    .header("content-type", "text/plain; charset=windows-1252")
                    .body(Full::new(Bytes::from_static(b"A \x80 page")))
                    .unwrap());
            }
            (_, "/short") => b"small".to_vec(),
            (_, unexpected) => panic!("Disallowed target received a network request: {unexpected}"),
        };
        Ok(response.body(Full::new(Bytes::from(body))).unwrap())
    }
}
