//! One WorkerLink attachment owns and fences its underlying TCP streams.
mod tcp;

use super::{Coordinator, id};
use crate::{encryption::Service, logging::Logs, protected_content::open_endpoint_content};
use cantrip_framing::tunnel::{self as wire, Frame};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Weak},
};
use tokio::{
    sync::{Semaphore, mpsc, watch},
    task::JoinSet,
};
use uuid::Uuid;

pub(super) const MAX_STREAMS: usize = 256;
const INBOUND_FRAMES: usize = 128;
const FROM_SOURCE: &str = "source-to-destination";
const FROM_DESTINATION: &str = "destination-to-source";

pub(super) enum Inbound {
    Retained,
    Consumed,
    Reply(Frame),
}

pub(super) enum Output {
    Queued,
    Pending,
    Closed,
}

pub(super) struct Tunnel {
    pub attachment: JsString,
    resource: JsString,
    source: Value,
    destination: Value,
    link: Link,
    capacity: watch::Sender<()>,
    limit: Arc<Semaphore>,
    streams: HashMap<JsString, mpsc::Sender<Frame>>,
    tasks: JoinSet<()>,
}

#[derive(Clone)]
struct Link {
    gateway: Weak<Coordinator>,
    logs: Arc<Logs>,
    channel: JsString,
    token: Uuid,
}

impl Tunnel {
    pub fn open(
        gateway: &Arc<Coordinator>,
        header: &Value,
        grant: &Value,
    ) -> Result<Box<Self>, &'static str> {
        let resource = &grant["resource"];
        let attachment = resource["attachmentId"]
            .as_js_string()
            .ok_or("resource-unavailable")?;
        let operations = grant["operations"].as_array().unwrap();
        if !operations.contains(&json!("stream:read"))
            || !operations.contains(&json!("stream:write"))
            || operations.contains(&json!("stream:guest-connect"))
            || operations.contains(&json!("stream:guest-listen"))
        {
            return Err("resource-unavailable");
        }
        Ok(Box::new(Self {
            attachment: attachment.clone(),
            resource: id(resource, "resourceId").clone(),
            source: json!(format!("worker-link-client:{}", id(grant, "grantId"))),
            destination: json!(format!("worker-link-worker:{}", gateway.worker)),
            link: Link {
                gateway: Arc::downgrade(gateway),
                logs: gateway.logs.clone(),
                channel: id(&header["channel"], "channelId").clone(),
                token: Uuid::new_v4(),
            },
            capacity: watch::channel(()).0,
            limit: gateway.tunnel_streams.clone(),
            streams: HashMap::new(),
            tasks: JoinSet::new(),
        }))
    }

    pub fn token(&self) -> Uuid {
        self.link.token
    }

    pub fn writable(&self) {
        self.capacity.send_replace(());
    }

    pub fn receive(&mut self, bytes: &[u8]) -> Result<Inbound, &'static str> {
        let frame = wire::decode(bytes.into()).map_err(|_| "protocol-error")?;
        let header = frame.header();
        let allowed = match header["kind"].as_str() {
            Some("connect") => {
                header["target"]["kind"] == "protected-tunnel"
                    && header["target"]["recordId"].as_js_string() == Some(&self.resource)
            }
            Some("data" | "half-close") => header["direction"] == FROM_SOURCE,
            Some("credit") => header["direction"] == FROM_DESTINATION,
            Some("close" | "error") => true,
            _ => false,
        };
        if !allowed
            || header["tunnelId"].as_js_string() != Some(&self.resource)
            || header["attachmentId"].as_js_string() != Some(&self.attachment)
            || header["sourceEndpointId"] != self.source
            || header["destinationEndpointId"] != self.destination
        {
            return Err("protocol-error");
        }
        let id = id(header, "connectionId");
        if header["kind"] == "connect" {
            while self.tasks.try_join_next().is_some() {}
            self.streams.retain(|_, sender| !sender.is_closed());
            if self.streams.contains_key(id) {
                return Ok(Inbound::Reply(
                    Reply::new(header).rejected("protocol-error"),
                ));
            }
            let Ok(permit) = self.limit.clone().try_acquire_owned() else {
                return Ok(Inbound::Reply(
                    Reply::new(header).rejected("limit-exceeded"),
                ));
            };
            let (sender, receiver) = mpsc::channel(INBOUND_FRAMES);
            self.streams.insert(id.clone(), sender);
            let link = self.link.clone();
            let capacity = self.capacity.subscribe();
            self.tasks.spawn(async move {
                let _permit = permit;
                tcp::serve(link, capacity, frame, receiver).await;
            });
            return Ok(Inbound::Consumed);
        }
        let Some(sender) = self.streams.get(id) else {
            return Ok(Inbound::Consumed);
        };
        match sender.try_send(frame) {
            Ok(()) => Ok(Inbound::Retained),
            Err(mpsc::error::TrySendError::Closed(_)) => Ok(Inbound::Consumed),
            Err(mpsc::error::TrySendError::Full(_)) => Err("congested"),
        }
    }
}

impl Link {
    fn active(&self) -> bool {
        self.gateway.upgrade().is_some_and(|gateway| {
            gateway.update_channels(|channels| channels.tunnel_active(&self.channel, self.token))
        })
    }

    fn send(&self, frame: &Frame) -> Output {
        self.gateway.upgrade().map_or(Output::Closed, |gateway| {
            gateway.update_channels(|channels| {
                channels.tunnel_output(&self.channel, self.token, frame.bytes())
            })
        })
    }

    fn credit(&self, frame: &Frame) {
        self.credit_bytes(frame.bytes().len());
    }

    fn credit_bytes(&self, bytes: usize) {
        if bytes > 0
            && let Some(gateway) = self.gateway.upgrade()
        {
            gateway.update_channels(|channels| {
                channels.tunnel_credit(&self.channel, self.token, bytes);
            });
        }
    }
}

struct Destination {
    host: String,
    port: u16,
    protection: Value,
}

enum TargetError {
    RecordUnavailable,
    WorkerMismatch,
    KindMismatch,
}

impl TargetError {
    fn code(&self) -> &'static str {
        match self {
            Self::RecordUnavailable => "protected-record-unavailable",
            Self::WorkerMismatch | Self::KindMismatch => "protected-target-invalid",
        }
    }

    fn reason(&self) -> &'static str {
        match self {
            Self::RecordUnavailable => "protected-record-open-failed",
            Self::WorkerMismatch => "worker-id-mismatch",
            Self::KindMismatch => "target-kind-mismatch",
        }
    }
}

impl Destination {
    fn open(service: &Service, worker: &JsString, header: &Value) -> Result<Self, TargetError> {
        let target = &header["target"];
        let record = &target["protectedRecord"];
        let server = service
            .server_identity()
            .map_err(|_| TargetError::RecordUnavailable)?;
        let scope = Value::Array(vec![json!("tunnel"), header["tunnelId"].clone()]).stringify();
        let binding = json!({
            "domain":"tunnel-content", "serverId":server, "workerId":worker, "scopeId":scope,
            "operationId":record["operationId"], "operation":"tunnel.record",
            "direction":"stored", "sequence":record["revision"],
        });
        let content = open_endpoint_content(
            service,
            &binding,
            &record["protectedContent"],
            "tunnelContentRecordSchema",
        )
        .map_err(|_| TargetError::RecordUnavailable)?;
        let destination = &content["destination"];
        if destination["workerId"].as_js_string() != Some(worker) {
            return Err(TargetError::WorkerMismatch);
        }
        if destination["kind"] != "worker-tcp"
            || target["targetKind"] != "tcp"
            || content["source"]["kind"] == "worker-os-listener"
        {
            return Err(TargetError::KindMismatch);
        }
        Ok(Self {
            host: destination["host"].as_str().unwrap().to_owned(),
            port: destination["port"].as_u64().unwrap() as u16,
            protection: content["dataProtection"].clone(),
        })
    }

    fn addresses(&self) -> Vec<SocketAddr> {
        let v4 = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let v6 = SocketAddr::from((Ipv6Addr::LOCALHOST, self.port));
        match self.host.as_str() {
            "127.0.0.1" => vec![v4],
            "::1" => vec![v6],
            "localhost" => vec![v6, v4],
            _ => unreachable!("validated TCP destination host"),
        }
    }
}

struct Reply {
    base: Value,
    sequence: u64,
}

impl Reply {
    fn new(source: &Value) -> Self {
        Self {
            base: Value::object(
                [
                    "protocolVersion",
                    "tunnelId",
                    "attachmentId",
                    "sourceEndpointId",
                    "destinationEndpointId",
                    "connectionId",
                ]
                .map(|name| (name, source[name].clone())),
            ),
            sequence: 0,
        }
    }

    fn header(&self, kind: &str, fields: &[(&str, Value)]) -> Value {
        let mut header = self.base.clone();
        header["sequence"] = json!(self.sequence);
        header["kind"] = json!(kind);
        for (field, value) in fields {
            header[*field] = value.clone();
        }
        header
    }

    fn control(&self, kind: &str, fields: &[(&str, Value)]) -> Frame {
        wire::create(self.header(kind, fields), &[]).expect("validated tunnel control frame")
    }

    fn rejected(&self, code: &'static str) -> Frame {
        self.control("rejected", &[("code", json!(code))])
    }
}
