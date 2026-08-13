use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use url::Url;

pub const CONNECTION_ENVIRONMENT_VARIABLE: &str = "CANTRIP_CLI_CONNECTION";

#[derive(Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CachedConnection {
    pub version: u8,
    pub endpoint: Url,
    pub server_url: Url,
    pub session_token: String,
    pub worker_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrokerHandshake {
    pub protocol_version: u8,
    pub server_url: Url,
    pub worker_id: String,
}

impl CachedConnection {
    fn validate(self) -> Result<Self, ConnectionError> {
        if self.version != 1 {
            return Err(ConnectionError::Invalid(format!(
                "unsupported connection version {}",
                self.version
            )));
        }
        if self.endpoint.scheme() != "http"
            || self.endpoint.host_str() != Some("127.0.0.1")
            || self.endpoint.port().is_none()
            || self.endpoint.path() != "/"
            || self.endpoint.query().is_some()
            || self.endpoint.fragment().is_some()
            || !self.endpoint.username().is_empty()
            || self.endpoint.password().is_some()
        {
            return Err(ConnectionError::Invalid(
                "the worker broker endpoint must be an uncredentialed loopback HTTP origin"
                    .to_string(),
            ));
        }
        if !matches!(self.server_url.scheme(), "http" | "https")
            || self.server_url.cannot_be_a_base()
            || self.server_url.path() != "/"
            || self.server_url.query().is_some()
            || self.server_url.fragment().is_some()
            || !self.server_url.username().is_empty()
            || self.server_url.password().is_some()
        {
            return Err(ConnectionError::Invalid(
                "the Cantrip server URL must be an uncredentialed HTTP(S) origin".to_string(),
            ));
        }
        if self.worker_id.is_empty() || self.worker_id.len() > 200 {
            return Err(ConnectionError::Invalid(
                "the cached worker identity is invalid".to_string(),
            ));
        }
        if self.session_token.len() < 32
            || !self
                .session_token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(ConnectionError::Invalid(
                "the cached broker session token is invalid".to_string(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug)]
pub enum ConnectionError {
    Broker(String),
    BrokerStatus {
        code: Option<String>,
        message: String,
        status: u16,
    },
    EnvironmentMissing,
    Invalid(String),
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl std::fmt::Display for ConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Broker(message) => write!(
                formatter,
                "Cantrip worker broker rejected the connection: {message}"
            ),
            Self::BrokerStatus {
                message, status, ..
            } => write!(formatter, "{message} (HTTP {status})"),
            Self::EnvironmentMissing => write!(
                formatter,
                "Cantrip CLI is not connected to a worker; run it from a Cantrip-managed terminal or agent"
            ),
            Self::Invalid(message) => {
                write!(formatter, "invalid Cantrip CLI connection: {message}")
            }
            Self::Read { path, source } => write!(
                formatter,
                "could not read Cantrip CLI connection {}: {source}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for ConnectionError {}

pub fn connection_path() -> Result<PathBuf, ConnectionError> {
    env::var_os(CONNECTION_ENVIRONMENT_VARIABLE)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or(ConnectionError::EnvironmentMissing)
}

pub fn load_connection() -> Result<CachedConnection, ConnectionError> {
    load_connection_from(&connection_path()?)
}

pub fn load_connection_from(path: &Path) -> Result<CachedConnection, ConnectionError> {
    let document = fs::read_to_string(path).map_err(|source| ConnectionError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_str::<CachedConnection>(&document)
        .map_err(|error| ConnectionError::Invalid(error.to_string()))?
        .validate()
}

pub fn handshake(connection: &CachedConnection) -> Result<BrokerHandshake, ConnectionError> {
    let result: BrokerHandshake =
        broker_request::<(), _>(connection, "GET", "/v1/handshake", None, 64 * 1024)?;
    if result.protocol_version != 1
        || result.server_url != connection.server_url
        || result.worker_id != connection.worker_id
    {
        return Err(ConnectionError::Broker(
            "handshake identity did not match the cached worker connection".to_string(),
        ));
    }
    Ok(result)
}

pub fn broker_post<TRequest: Serialize, TResponse: DeserializeOwned>(
    connection: &CachedConnection,
    path: &str,
    payload: &TRequest,
) -> Result<TResponse, ConnectionError> {
    broker_request(connection, "POST", path, Some(payload), 2 * 1024 * 1024)
}

fn broker_request<TRequest: Serialize, TResponse: DeserializeOwned>(
    connection: &CachedConnection,
    method: &str,
    path: &str,
    payload: Option<&TRequest>,
    maximum_response_bytes: usize,
) -> Result<TResponse, ConnectionError> {
    let port = connection
        .endpoint
        .port()
        .ok_or_else(|| ConnectionError::Invalid("the broker port is missing".to_string()))?;
    let mut stream = TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_secs(5),
    )
    .map_err(|error| ConnectionError::Broker(error.to_string()))?;
    // Commands such as worktree creation may clone over a slow network. The
    // local broker owns cancellation and connection lifetime, so do not impose
    // an arbitrary operation timeout in the CLI transport.
    stream
        .set_read_timeout(None)
        .map_err(|error| ConnectionError::Broker(error.to_string()))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| ConnectionError::Broker(error.to_string()))?;
    let body = payload
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|error| ConnectionError::Broker(error.to_string()))?
        .unwrap_or_default();
    write!(stream, "{method} {path} HTTP/1.1\r\n")
        .and_then(|_| write!(stream, "Host: 127.0.0.1:{port}\r\n"))
        .and_then(|_| {
            write!(
                stream,
                "Authorization: Bearer {}\r\n",
                connection.session_token
            )
        })
        .and_then(|_| write!(stream, "Accept: application/json\r\n"))
        .and_then(|_| {
            if body.is_empty() {
                Ok(())
            } else {
                write!(
                    stream,
                    "Content-Type: application/json\r\nContent-Length: {}\r\n",
                    body.len()
                )
            }
        })
        .and_then(|_| write!(stream, "Connection: close\r\n\r\n"))
        .and_then(|_| stream.write_all(&body))
        .map_err(|error| ConnectionError::Broker(error.to_string()))?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| ConnectionError::Broker(error.to_string()))?;
    let mut response = Vec::new();
    stream
        .take((maximum_response_bytes + 16 * 1024 + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|error| ConnectionError::Broker(error.to_string()))?;
    if response.len() > maximum_response_bytes + 16 * 1024 {
        return Err(ConnectionError::Broker(
            "broker response exceeded the command limit".to_string(),
        ));
    }
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| ConnectionError::Broker("malformed HTTP response".to_string()))?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|error| ConnectionError::Broker(error.to_string()))?;
    let status_line = headers.lines().next().unwrap_or_default();
    let status = status_line
        .split_ascii_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| ConnectionError::Broker("malformed HTTP status".to_string()))?;
    let response_body = &response[header_end + 4..];
    if !(200..300).contains(&status) {
        #[derive(Deserialize)]
        struct ErrorBody {
            code: Option<String>,
            error: Option<String>,
        }
        let error = serde_json::from_slice::<ErrorBody>(response_body).ok();
        return Err(ConnectionError::BrokerStatus {
            code: error.as_ref().and_then(|value| value.code.clone()),
            message: error
                .and_then(|value| value.error)
                .unwrap_or_else(|| status_line.to_string()),
            status,
        });
    }
    serde_json::from_slice::<TResponse>(response_body)
        .map_err(|error| ConnectionError::Broker(error.to_string()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use tempfile::tempdir;

    use super::{CachedConnection, ConnectionError, handshake, load_connection_from};

    #[test]
    fn loads_a_worker_broker_connection() {
        let directory = tempdir().expect("temporary directory");
        let pathname = directory.path().join("cli-connection.json");
        fs::write(
            &pathname,
            r#"{
  "version": 1,
  "endpoint": "http://127.0.0.1:43123",
  "serverUrl": "https://cantrip.example",
  "sessionToken": "abcdefghijklmnopqrstuvwxyz0123456789_-",
  "workerId": "worker-example"
}
"#,
        )
        .expect("connection document");

        let connection = load_connection_from(&pathname).expect("valid connection");
        assert_eq!(connection.worker_id, "worker-example");
        assert_eq!(connection.endpoint.as_str(), "http://127.0.0.1:43123/");
        assert_eq!(connection.server_url.as_str(), "https://cantrip.example/");
    }

    #[test]
    fn rejects_non_loopback_brokers() {
        let directory = tempdir().expect("temporary directory");
        let pathname = directory.path().join("cli-connection.json");
        fs::write(
            &pathname,
            r#"{
  "version": 1,
  "endpoint": "https://remote.example:443",
  "serverUrl": "https://cantrip.example",
  "sessionToken": "abcdefghijklmnopqrstuvwxyz0123456789_-",
  "workerId": "worker-example"
}
"#,
        )
        .expect("connection document");

        assert!(matches!(
            load_connection_from(&pathname),
            Err(ConnectionError::Invalid(_))
        ));
    }

    #[test]
    fn authenticates_to_the_cached_worker_broker() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let port = listener.local_addr().expect("listener address").port();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("broker connection");
            let mut request = Vec::new();
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let mut chunk = [0_u8; 1024];
                let length = stream.read(&mut chunk).expect("handshake request");
                assert!(length > 0, "broker request ended before its headers");
                request.extend_from_slice(&chunk[..length]);
                assert!(request.len() <= 16 * 1024, "broker request was too large");
            }
            let request = std::str::from_utf8(&request).expect("HTTP request");
            assert!(request.contains("GET /v1/handshake HTTP/1.1"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer abcdefghijklmnopqrstuvwxyz0123456789_-")
            );
            let body = r#"{"protocolVersion":1,"serverUrl":"https://cantrip.example","workerId":"worker-example"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("handshake response");
        });
        let connection = CachedConnection {
            version: 1,
            endpoint: format!("http://127.0.0.1:{port}")
                .parse()
                .expect("broker URL"),
            server_url: "https://cantrip.example".parse().expect("server URL"),
            session_token: "abcdefghijklmnopqrstuvwxyz0123456789_-".to_string(),
            worker_id: "worker-example".to_string(),
        }
        .validate()
        .expect("connection");

        let result = handshake(&connection).expect("authenticated handshake");
        assert_eq!(result.worker_id, "worker-example");
        worker.join().expect("broker thread");
    }
}
