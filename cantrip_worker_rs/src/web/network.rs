use anyhow::{Context, Result, anyhow, bail, ensure};
use reqwest::{
    Client, Method,
    header::{self, HeaderMap},
    redirect::Policy,
};
use std::{
    collections::HashMap,
    io::{Cursor, Read},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    net::lookup_host,
    sync::{OwnedSemaphorePermit, Semaphore},
    time::timeout,
};
use url::{Host, Url};

const REDIRECTS: usize = 5;
const ACCEPT: &str = "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.1";
pub(super) const USER_AGENT: &str =
    "CantripResearchBot/1.0 (+https://github.com/ArcaneArts/Cantrip)";
const READ_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) struct Limits {
    pub compressed: usize,
    pub expanded: usize,
    pub types: &'static [&'static str],
}

pub(super) struct Page {
    pub bytes: Vec<u8>,
    pub content_type: String,
    pub charset: Option<String>,
    pub status: u16,
    pub url: Url,
}

pub(super) enum Response {
    Redirect(Url),
    Page(Page),
}

pub(super) struct Network {
    global: Arc<Semaphore>,
    hosts: Mutex<HashMap<String, Weak<Semaphore>>>,
    #[cfg(test)]
    pub fixture: Option<SocketAddr>,
}

impl Default for Network {
    fn default() -> Self {
        Self {
            global: Arc::new(Semaphore::new(8)),
            hosts: Mutex::new(HashMap::new()),
            #[cfg(test)]
            fixture: None,
        }
    }
}

pub(super) fn normalize(mut url: Url) -> Result<Url> {
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "Web reads accept only HTTP and HTTPS URLs."
    );
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "Web URLs cannot contain credentials."
    );
    ensure!(
        url.port().is_none(),
        "Web reads accept only standard HTTP and HTTPS ports."
    );
    match url.host().context("Web reads require a host.")? {
        Host::Domain(domain) => {
            let hostname = domain.trim_end_matches('.');
            ensure!(
                hostname != "localhost"
                    && ![".localhost", ".local", ".internal"]
                        .iter()
                        .any(|suffix| hostname.ends_with(suffix)),
                "Web reads cannot access local or private hosts."
            );
        }
        Host::Ipv4(ip) => ensure!(
            public_address(ip.into()),
            "Web reads cannot access local or private addresses."
        ),
        Host::Ipv6(ip) => ensure!(
            public_address(ip.into()),
            "Web reads cannot access local or private addresses."
        ),
    }
    url.set_fragment(None);
    Ok(url)
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !matches!(
                (a, b, c),
                (0 | 10 | 127 | 224..=255, _, _)
                    | (100, 64..=127, _)
                    | (169, 254, _)
                    | (172, 16..=31, _)
                    | (192, 0, 0 | 2)
                    | (192, 168, _)
                    | (198, 18 | 19, _)
                    | (198, 51, 100)
                    | (203, 0, 113)
            )
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return public_address(mapped.into());
            }
            let [a, b, ..] = ip.segments();
            // Only global unicast. Exclude special-use assignments and 6to4,
            // where a public-looking address can embed a private IPv4 target.
            a & 0xe000 == 0x2000
                && !(a == 0x2001 && (b < 0x0200 || b == 0x0db8))
                && a != 0x2002
                && a != 0x3fff
        }
    }
}

fn approved_address(mut addresses: impl Iterator<Item = SocketAddr>) -> Result<SocketAddr> {
    let chosen = addresses
        .next()
        .filter(|chosen| public_address(chosen.ip()));
    ensure!(
        chosen.is_some() && addresses.all(|address| public_address(address.ip())),
        "Web reads cannot access hosts resolving to local or private addresses."
    );
    Ok(chosen.unwrap())
}

pub(super) fn redirect(url: &Url, location: &str) -> Result<Url> {
    let target = normalize(url.join(location)?)?;
    ensure!(
        url.scheme() != "https" || target.scheme() == "https",
        "Web redirects cannot downgrade HTTPS to HTTP."
    );
    Ok(target)
}

pub(super) async fn follow<Fut>(
    mut url: Url,
    mut hop: impl FnMut(Url) -> Fut + Send,
) -> Result<Page>
where
    Fut: Future<Output = Result<Response>> + Send,
{
    for _ in 0..=REDIRECTS {
        match hop(url).await? {
            Response::Redirect(next) => url = next,
            Response::Page(page) => return Ok(page),
        }
    }
    bail!("Web response exceeded the redirect limit.")
}

impl Network {
    async fn send(
        &self,
        url: Url,
        method: Method,
        headers: HeaderMap,
    ) -> Result<(reqwest::Response, [OwnedSemaphorePermit; 2])> {
        let host = url.host().context("Web reads require a host.")?;
        let key = url.host_str().unwrap().trim_end_matches('.');
        let host_limit = {
            let mut hosts = self.hosts.lock().unwrap();
            hosts.retain(|_, limit| limit.strong_count() > 0);
            match hosts.get(key).and_then(Weak::upgrade) {
                Some(limit) => limit,
                None => {
                    let limit = Arc::new(Semaphore::new(2));
                    hosts.insert(key.to_string(), Arc::downgrade(&limit));
                    limit
                }
            }
        };
        let host_permit = host_limit.acquire_owned().await?;
        let global_permit = self.global.clone().acquire_owned().await?;

        let mut client = Client::builder()
            .no_proxy()
            .no_gzip()
            .no_deflate()
            .no_brotli()
            .redirect(Policy::none())
            .http1_only()
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(READ_TIMEOUT);
        if let Host::Domain(name) = host {
            let port = url.port_or_known_default().unwrap();
            #[cfg(test)]
            let chosen = if name.ends_with(".example") {
                if let Some(socket) = self.fixture {
                    socket
                } else {
                    resolve(name, port).await?
                }
            } else {
                resolve(name, port).await?
            };
            #[cfg(not(test))]
            let chosen = resolve(name, port).await?;
            client = client.resolve(name, chosen);
        }
        let response = client
            .build()?
            .request(method, url)
            .headers(headers)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?;
        Ok((response, [host_permit, global_permit]))
    }

    pub(super) async fn get(&self, url: Url, limits: &Limits) -> Result<Response> {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT, ACCEPT.parse()?);
        headers.insert(header::ACCEPT_ENCODING, "gzip, deflate, br".parse()?);
        headers.insert(header::USER_AGENT, USER_AGENT.parse()?);
        let (mut response, permits) = self.send(url.clone(), Method::GET, headers).await?;
        let status = response.status().as_u16();
        let location = if (300..400).contains(&status) {
            response
                .headers()
                .get(header::LOCATION)
                .map(|value| value.to_str().map(str::to_owned))
                .transpose()?
                .filter(|value| !value.is_empty())
        } else {
            None
        };
        let raw = head(&response, header::CONTENT_TYPE);
        let content_type = raw.split(';').next().unwrap().trim().to_ascii_lowercase();
        if location.is_none() {
            ensure!(
                limits.types.contains(&content_type.as_str()),
                "Web read does not support content type {}.",
                if content_type.is_empty() {
                    "unknown"
                } else {
                    &content_type
                }
            );
        }
        let charset = raw.split(';').skip(1).find_map(|part| {
            let (name, value) = part.split_once('=')?;
            name.trim()
                .eq_ignore_ascii_case("charset")
                .then(|| value.trim().trim_matches(['\'', '"']).to_ascii_lowercase())
        });
        let encoding = head(&response, header::CONTENT_ENCODING)
            .split(',')
            .next()
            .unwrap()
            .trim()
            .to_ascii_lowercase();
        let message = if location.is_some() {
            "Web redirect response exceeds the compressed byte limit."
        } else {
            "Web response exceeds the compressed byte limit."
        };
        let bytes = collect(&mut response, limits.compressed, message).await?;
        if let Some(location) = location {
            return Ok(Response::Redirect(redirect(&url, &location)?));
        }

        let expanded = limits.expanded;
        let bytes = tokio::task::spawn_blocking(move || {
            let _permits = permits;
            expand(bytes, &encoding, expanded)
        })
        .await??;
        Ok(Response::Page(Page {
            bytes,
            content_type,
            charset,
            status,
            url,
        }))
    }

    pub(super) async fn resource(
        &self,
        url: Url,
        method: Method,
        headers: HeaderMap,
    ) -> Result<Resource> {
        const LIMIT: usize = 20_000_000;
        let is_head = method == Method::HEAD;
        let (mut response, permits) = self.send(url.clone(), method, headers).await?;
        let status = response.status();
        ensure!(
            status.as_u16() >= 200,
            "Browser resource returned an unsupported status."
        );
        let headers = response.headers().clone();
        if status.is_redirection()
            && let Some(location) = headers.get(header::LOCATION)
        {
            redirect(&url, location.to_str()?)?;
        }
        ensure!(
            !head(&response, header::CONTENT_TYPE)
                .split(';')
                .next()
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream")),
            "Browser event streams are disabled for rendered reading."
        );
        let body = if is_head {
            Vec::new()
        } else {
            collect(
                &mut response,
                LIMIT,
                "Browser resource exceeds the response byte limit.",
            )
            .await?
        };
        let encoding = headers
            .get(header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let body = if body.is_empty() {
            body
        } else {
            tokio::task::spawn_blocking(move || {
                let _permits = permits;
                expand(body, &encoding, LIMIT)
            })
            .await??
        };
        Ok(Resource {
            status: status.as_u16(),
            headers,
            body,
            is_head,
        })
    }
}

pub(super) struct Resource {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    pub is_head: bool,
}

async fn collect(response: &mut reqwest::Response, limit: usize, message: &str) -> Result<Vec<u8>> {
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= limit as u64),
        "{message}"
    );
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)?
    {
        ensure!(chunk.len() <= limit - body.len(), "{message}");
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn resolve(name: &str, port: u16) -> Result<SocketAddr> {
    let addresses = timeout(Duration::from_secs(5), lookup_host((name, port)))
        .await
        .context("Public hostname lookup timed out.")?
        .context("Public hostname lookup failed.")?;
    approved_address(addresses)
}

fn head(response: &reqwest::Response, name: header::HeaderName) -> &str {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

fn expand(bytes: Vec<u8>, encoding: &str, limit: usize) -> Result<Vec<u8>> {
    if matches!(encoding, "" | "identity") {
        ensure!(
            bytes.len() <= limit,
            "Web response exceeds the expanded byte limit."
        );
        return Ok(bytes);
    }
    let input = Cursor::new(bytes);
    let mut decoder: Box<dyn Read> = match encoding {
        "gzip" | "x-gzip" => Box::new(flate2::read::MultiGzDecoder::new(input)),
        "deflate" => Box::new(flate2::read::ZlibDecoder::new(input)),
        "br" => Box::new(brotli::Decompressor::new(input, 8192)),
        other => return Err(anyhow!("Unsupported web response encoding: {other}")),
    };
    let mut body = Vec::new();
    (&mut decoder)
        .take(limit as u64 + 1)
        .read_to_end(&mut body)?;
    ensure!(
        body.len() <= limit,
        "Web response exceeds the expanded byte limit."
    );
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn public_destination_checks_all_answers_and_redirects() {
        let ip = |address: &str| address.parse().unwrap();
        assert!(public_address(ip("2606:4700::1")));
        assert!(public_address(ip("::ffff:1.1.1.1")));
        for address in [
            "169.254.169.254",
            "192.0.2.1",
            "100.64.0.2",
            "0.0.0.0",
            "::ffff:7f00:1",
            "64:ff9b::7f00:1",
            "2002:7f00:1::",
            "fe80::1",
        ] {
            assert!(!public_address(ip(address)), "{address}");
        }
        let public = (Ipv4Addr::new(1, 1, 1, 1), 443).into();
        let private = (Ipv4Addr::LOCALHOST, 443).into();
        assert_eq!(approved_address([public].into_iter()).unwrap(), public);
        assert!(approved_address([public, private].into_iter()).is_err());
        let source = normalize(Url::parse("https://example.com/a#secret").unwrap()).unwrap();
        assert_eq!(source.as_str(), "https://example.com/a");
        assert_eq!(redirect(&source, "/b").unwrap().path(), "/b");
        for target in [
            "http://example.com",
            "https://x.LOCALHOST./",
            "https://example.com:81/",
            "https://u:p@example.com",
            "https://0x7f000001/",
            "https://[::ffff:7f00:1]/",
        ] {
            assert!(redirect(&source, target).is_err(), "{target}");
        }
    }

    #[test]
    fn compressed_limits_are_applied_to_expanded_bytes() {
        use std::io::Write;
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gzip.write_all(b"a document").unwrap();
        let gzip = gzip.finish().unwrap();
        assert_eq!(expand(gzip.clone(), "gzip", 10).unwrap(), b"a document");
        assert!(expand(gzip, "gzip", 9).is_err());
        assert!(expand(vec![0], "unknown", 10).is_err());
    }
}
