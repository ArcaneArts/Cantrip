//! pg_dump talks to a private local endpoint; Rust carries the original wire
//! protocol over the same configured TLS connector as ordinary database work.
use super::native_pglite::{ExportFailure, failure};
use anyhow::{Context, Result, bail, ensure};
use parking_lot::Mutex;
use postgres_native_tls::MakeTlsConnector;
use std::{net::IpAddr, path::Path, process::Stdio, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::Command,
    task::JoinSet,
};
use tokio_postgres::{
    Config,
    config::{ChannelBinding, Host, LoadBalanceHosts, SslMode, SslNegotiation, TargetSessionAttrs},
    tls::{MakeTlsConnect, TlsConnect},
};

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}
type Wire = Box<dyn Stream>;
#[derive(Clone)]
struct Endpoint {
    host: Option<Host>,
    address: Option<IpAddr>,
    port: u16,
    configuration: Config,
    tls: MakeTlsConnector,
}
impl Endpoint {
    async fn connect(&self) -> Result<Wire> {
        let domain = match &self.host {
            Some(Host::Tcp(host)) => host.as_str(),
            _ => "",
        };
        let connect = async {
            #[cfg(unix)]
            if let Some(Host::Unix(directory)) = &self.host
                && self.address.is_none()
            {
                let stream = tokio::net::UnixStream::connect(
                    directory.join(format!(".s.PGSQL.{}", self.port)),
                )
                .await?;
                return Ok::<Wire, std::io::Error>(Box::new(stream));
            }
            let stream = if let Some(address) = self.address {
                TcpStream::connect((address, self.port)).await?
            } else {
                TcpStream::connect((domain, self.port)).await?
            };
            stream.set_nodelay(true)?;
            Ok::<Wire, std::io::Error>(Box::new(stream))
        };
        let mut stream = match self.configuration.get_connect_timeout() {
            Some(timeout) => tokio::time::timeout(*timeout, connect).await??,
            None => connect.await?,
        };
        let mode = self.configuration.get_ssl_mode();
        if mode == SslMode::Disable {
            return Ok(stream);
        }
        if self.configuration.get_ssl_negotiation() == SslNegotiation::Direct {
            ensure!(mode == SslMode::Require, "direct TLS requires TLS");
        } else {
            stream.write_all(&[0, 0, 0, 8, 4, 210, 22, 47]).await?;
            if stream.read_u8().await? != b'S' {
                ensure!(mode != SslMode::Require, "PostgreSQL does not support TLS");
                return Ok(stream);
            }
        }
        ensure!(!domain.is_empty(), "TLS needs a PostgreSQL hostname");
        let mut tls = self.tls.clone();
        let connect =
            <MakeTlsConnector as MakeTlsConnect<Wire>>::make_tls_connect(&mut tls, domain)?;
        Ok(Box::new(connect.connect(stream).await?))
    }
}

// The random startup token authenticates this ephemeral endpoint before opening
// a remote connection, including a Unix peer/trust connection. It is removed
// before forwarding startup; only the configured remote options are restored.
async fn startup(
    stream: &mut TcpStream,
    token: &str,
    user: &str,
    database: &str,
    options: Option<&str>,
) -> Result<Vec<u8>> {
    loop {
        let length = stream.read_u32().await?;
        ensure!((8..=10_000).contains(&length), "invalid startup length");
        let mut body = vec![0; (length - 4) as usize];
        stream.read_exact(&mut body).await?;
        match u32::from_be_bytes(body[..4].try_into()?) {
            80_877_103 | 80_877_104 => stream.write_all(b"N").await?,
            196_608 => {
                let values = std::str::from_utf8(&body[4..])?;
                ensure!(values.ends_with("\0\0"), "invalid startup fields");
                let values: Vec<_> = values[..values.len() - 1].split_terminator('\0').collect();
                ensure!(values.len().is_multiple_of(2), "invalid startup pairs");
                let mut forwarded = 196_608u32.to_be_bytes().to_vec();
                let mut valid_token = false;
                let mut valid_user = false;
                let mut valid_database = false;
                for pair in values.chunks_exact(2) {
                    match pair[0] {
                        "options" => {
                            valid_token = bool::from(pair[1].as_bytes().ct_eq(token.as_bytes()));
                            continue;
                        }
                        "user" => valid_user = pair[1] == user,
                        "database" => valid_database = pair[1] == database,
                        _ => {}
                    }
                    forwarded.extend_from_slice(pair[0].as_bytes());
                    forwarded.push(0);
                    forwarded.extend_from_slice(pair[1].as_bytes());
                    forwarded.push(0);
                }
                ensure!(
                    valid_token && valid_user && valid_database,
                    "invalid private export startup"
                );
                if let Some(options) = options {
                    forwarded.extend_from_slice(b"options\0");
                    forwarded.extend_from_slice(options.as_bytes());
                    forwarded.push(0);
                }
                forwarded.push(0);
                let mut packet = ((forwarded.len() + 4) as u32).to_be_bytes().to_vec();
                packet.extend_from_slice(&forwarded);
                return Ok(packet);
            }
            _ => bail!("unsupported export startup"),
        }
    }
}
async fn serve(
    listener: TcpListener,
    endpoint: Endpoint,
    token: String,
    user: String,
    database: String,
    diagnostics: Arc<Mutex<Vec<String>>>,
) -> Result<()> {
    let mut peers = JoinSet::new();
    loop {
        tokio::select! {
            accepted=listener.accept()=>{
                let(mut local,_)=accepted?;local.set_nodelay(true)?;let endpoint=endpoint.clone();let token=token.clone();let user=user.clone();let database=database.clone();let diagnostics=diagnostics.clone();
                peers.spawn(async move {
                    let result:Result<()>=async {
                        let startup=tokio::time::timeout(Duration::from_secs(2),startup(&mut local,&token,&user,&database,endpoint.configuration.get_options())).await??;
                        let mut remote=endpoint.connect().await?;
                        remote.write_all(&startup).await?;
                        tokio::io::copy_bidirectional(&mut local,&mut remote).await?;
                        Ok(())
                    }.await;
                    if let Err(error)=result {let mut errors=diagnostics.lock();if errors.len()<8{errors.push(format!("{error:#}"));}}
                });
            },
            _=peers.join_next(),if !peers.is_empty()=>{},
        }
    }
}

pub(crate) async fn dump_sql(
    configuration: &Config,
    tls: MakeTlsConnector,
    user: &str,
    database: &str,
    executable: &Path,
) -> Result<String> {
    dump_inner(configuration, tls, user, database, executable)
        .await
        .map_err(|error| {
            if error.is::<ExportFailure>() {
                error
            } else {
                failure(error, "PostgreSQL pg_dump")
            }
        })
}
async fn dump_inner(
    configuration: &Config,
    tls: MakeTlsConnector,
    user: &str,
    database: &str,
    executable: &Path,
) -> Result<String> {
    let count = configuration
        .get_hosts()
        .len()
        .max(configuration.get_hostaddrs().len())
        .max(1);
    let token = format!(
        "-c cantrip_export_token={}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut servers = JoinSet::new();
    let mut ports = Vec::new();
    let diagnostics = Arc::new(Mutex::new(Vec::new()));
    for index in 0..count {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        ports.push(listener.local_addr()?.port().to_string());
        let endpoint = Endpoint {
            host: configuration.get_hosts().get(index).cloned(),
            address: configuration.get_hostaddrs().get(index).copied(),
            port: configuration
                .get_ports()
                .get(index)
                .or_else(|| configuration.get_ports().first())
                .copied()
                .unwrap_or(5432),
            configuration: configuration.clone(),
            tls: tls.clone(),
        };
        servers.spawn(serve(
            listener,
            endpoint,
            token.clone(),
            user.to_owned(),
            database.to_owned(),
            diagnostics.clone(),
        ));
    }
    let attrs = match configuration.get_target_session_attrs() {
        TargetSessionAttrs::ReadWrite => "read-write",
        TargetSessionAttrs::ReadOnly => "read-only",
        _ => "any",
    };
    let balance = match configuration.get_load_balance_hosts() {
        LoadBalanceHosts::Random => "random",
        _ => "disable",
    };
    let binding = match configuration.get_channel_binding() {
        ChannelBinding::Require => "require",
        ChannelBinding::Disable => "disable",
        _ => "prefer",
    };
    let mut command = Command::new(executable);
    command
        .args([
            "--no-password",
            "--inserts",
            "--no-owner",
            "--no-privileges",
            "--encoding=UTF8",
        ])
        .args(super::dump_stream::OPTIONS)
        .env("PGHOST", vec!["127.0.0.1"; count].join(","))
        .env_remove("PGHOSTADDR")
        .env("PGPORT", ports.join(","))
        .env("PGUSER", user)
        .env("PGDATABASE", database)
        .env("PGOPTIONS", token)
        .env("PGSSLMODE", "disable")
        .env("PGGSSENCMODE", "disable")
        .env("PGCHANNELBINDING", binding)
        .env_remove("PGREQUIREAUTH")
        .env("PGTARGETSESSIONATTRS", attrs)
        .env("PGLOADBALANCEHOSTS", balance)
        .env(
            "PGAPPNAME",
            configuration
                .get_application_name()
                .unwrap_or("cantrip-offline-export"),
        )
        .env_remove("PGSERVICE")
        .env_remove("PGSERVICEFILE")
        .env_remove("PGPASSWORD")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(timeout) = configuration.get_connect_timeout() {
        command.env("PGCONNECT_TIMEOUT", timeout.as_secs().max(1).to_string());
    } else {
        command.env_remove("PGCONNECT_TIMEOUT");
    }
    if let Some(password) = configuration.get_password() {
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStringExt;
            command.env(
                "PGPASSWORD",
                std::ffi::OsString::from_vec(password.to_vec()),
            );
        }
        #[cfg(not(unix))]
        {
            command.env("PGPASSWORD", std::str::from_utf8(password)?);
        }
    }
    let child = command.spawn().context("launch native pg_dump")?;
    let wait = child.wait_with_output();
    tokio::pin!(wait);
    let output = tokio::select! {
        output=&mut wait=>output?,
        result=servers.join_next()=>{result.context("export endpoint ended")???;bail!("export endpoint ended before pg_dump");},
    };
    servers.abort_all();
    while servers.join_next().await.is_some() {}
    ensure!(
        output.status.success(),
        "pg_dump exited {:?}: {}; transport: {:?}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr),
        diagnostics.lock()
    );
    super::dump_stream::decode(&output.stdout)
}
