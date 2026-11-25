//! Headless WorkerLink client for external MCP.
use anyhow::{Context, Result, bail, ensure};
use cantrip_crypto::{checked, content::external_mcp::Exchange};
use cantrip_framing::worker_link as wire;
use cantrip_wire::{Value, parse_json_text, value::json};
use futures::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};
use url::Url;
use uuid::Uuid;

const CREDIT_BYTES: usize = 64 * 1024;
const PAYLOAD_FORMAT: &str = "external-mcp-v1";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub(super) fn session_id(opened: &Value) -> Result<&str> {
    let id = opened["session"]["sessionId"]
        .as_str()
        .context("Missing WorkerLink session identity")?;
    Uuid::parse_str(id).context("Invalid WorkerLink session identity")?;
    Ok(id)
}

pub(super) async fn worker_context(
    mut url: Url,
    credential: &str,
    opened: &Value,
    project: &str,
) -> Result<Value> {
    let session = checked("workerLinkSessionSchema", &opened["session"])?;
    let grant = checked("workerLinkResourceGrantSchema", &opened["grant"])?;
    let binding = &grant["binding"];
    ensure!(
        binding["identity"] == session["identity"]
            && binding["sessionId"] == session["sessionId"]
            && binding["resource"]["kind"] == "external-mcp"
            && binding["resource"]["resourceId"] == project,
        "WorkerLink granted a different MCP resource."
    );
    let worker_key = checked("encryptionPublicKeySchema", &opened["workerPublicKey"])?;
    let websocket_scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(websocket_scheme)
        .map_err(|()| anyhow::anyhow!("Invalid WorkerLink relay origin."))?;
    let mut request = url.as_str().into_client_request()?;
    let mut auth = HeaderValue::from_str(&format!("Bearer {credential}"))?;
    auth.set_sensitive(true);
    request.headers_mut().insert("authorization", auth);
    let (mut socket, _) = connect_async(request)
        .await
        .context("Could not connect to the WorkerLink relay.")?;
    let channel =
        json!({"channelId":Uuid::new_v4().to_string(),"connectionId":Uuid::new_v4().to_string()});
    let exchange = Exchange::new(binding, &channel);
    let route = json!({
        "protocolVersion":1,"sessionId":session["sessionId"],"routeGeneration":session["routeGeneration"],
        "effectiveRoute":"relay","channel":channel,"lane":"stream",
    });
    let mut open = route.clone();
    open["kind"] = json!("open");
    open["sequence"] = json!(0);
    open["openNonce"] = json!(Uuid::new_v4().to_string());
    open["channelKind"] = json!("reliable-stream");
    open["grant"] = grant;
    open["initialCreditBytes"] = json!(CREDIT_BYTES);
    send(&mut socket, open, &[]).await?;
    let accept = receive(&mut socket, &route, 0).await?;
    ensure!(
        accept.header()["kind"] == "accept",
        "WorkerLink denied the MCP channel ({}).",
        accept.header()["code"]
            .as_str()
            .unwrap_or("no acknowledgement")
    );
    let (key, request) = exchange.seal_request(&worker_key, b"worker-context")?;
    ensure!(
        accept.header()["initialCreditBytes"]
            .as_u64()
            .unwrap_or_default()
            >= request.len() as u64,
        "WorkerLink offered too little credit for the MCP request."
    );
    let mut data = route.clone();
    data["kind"] = json!("data");
    data["sequence"] = json!(1);
    data["direction"] = json!("client-to-worker");
    data["payloadFormat"] = json!(PAYLOAD_FORMAT);
    send(&mut socket, data, &request).await?;
    for sequence in 1..=3 {
        let frame = receive(&mut socket, &route, sequence).await?;
        let header = frame.header();
        match header["kind"].as_str() {
            Some("credit") if header["direction"] == "client-to-worker" => continue,
            Some("data")
                if header["direction"] == "worker-to-client"
                    && header["payloadFormat"] == PAYLOAD_FORMAT
                    && frame.payload().len() <= CREDIT_BYTES =>
            {
                let plaintext = exchange.open_response(&key, frame.payload())?;
                let result = parse_json_text(std::str::from_utf8(&plaintext)?)
                    .map_err(|_| anyhow::anyhow!("Invalid MCP worker response."))?;
                ensure!(
                    result["projectId"] == project && result["summary"].is_string(),
                    "Invalid MCP worker response."
                );
                let _ = socket.close(None).await;
                return Ok(result);
            }
            _ => bail!("The WorkerLink MCP channel closed before the worker replied."),
        }
    }
    bail!("The WorkerLink MCP channel did not return an encrypted result.")
}

async fn send(socket: &mut Socket, header: Value, payload: &[u8]) -> Result<()> {
    let frame = wire::create(header, payload)?;
    socket
        .send(Message::Binary(frame.bytes().to_vec().into()))
        .await?;
    Ok(())
}

async fn receive(socket: &mut Socket, route: &Value, sequence: u64) -> Result<wire::Frame> {
    while let Some(message) = socket.next().await {
        match message? {
            Message::Binary(bytes) => {
                let frame = wire::decode(bytes.to_vec().into())?;
                let header = frame.header();
                ensure!(
                    [
                        "sessionId",
                        "routeGeneration",
                        "effectiveRoute",
                        "channel",
                        "lane"
                    ]
                    .iter()
                    .all(|key| header[*key] == route[*key])
                        && header["sequence"].as_u64() == Some(sequence),
                    "The WorkerLink relay returned a stale MCP frame."
                );
                return Ok(frame);
            }
            Message::Ping(_) => socket.flush().await?,
            Message::Pong(_) => {}
            _ => break,
        }
    }
    bail!("The WorkerLink relay disconnected.")
}
