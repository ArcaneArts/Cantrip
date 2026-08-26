use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
use tokio_tungstenite::{accept_async, connect_async, tungstenite::Message};

const PAYLOAD_SIZES: [usize; 3] = [1_024, 64 * 1_024, 1_024 * 1_024];
const TARGET_BYTES: usize = 64 * 1_024 * 1_024;
const MIN_ITERATIONS: usize = 32;
const MAX_ITERATIONS: usize = 4_096;
type SpikeError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurement {
    topology: &'static str,
    payload_bytes: usize,
    iterations: usize,
    p50_round_trip_micros: u128,
    p95_round_trip_micros: u128,
    useful_mib_per_second: f64,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), SpikeError> {
    let mut measurements = Vec::new();
    for payload_bytes in PAYLOAD_SIZES {
        let iterations = (TARGET_BYTES / payload_bytes).clamp(MIN_ITERATIONS, MAX_ITERATIONS);
        measurements.push(benchmark_in_process(payload_bytes, iterations).await?);
        measurements.push(benchmark_peer_socket(payload_bytes, iterations).await?);
        measurements.push(benchmark_webview_bridge(payload_bytes, iterations).await?);
    }
    println!("{}", serde_json::to_string_pretty(&measurements)?);
    Ok(())
}

async fn benchmark_in_process(
    payload_bytes: usize,
    iterations: usize,
) -> Result<Measurement, SpikeError> {
    let (mut client, worker) = tokio::io::duplex(payload_bytes.saturating_mul(2).max(64 * 1_024));
    let worker_task = tokio::spawn(echo_framed(worker));
    let result = measure_framed(
        "native-in-process-lower-bound",
        &mut client,
        payload_bytes,
        iterations,
    )
    .await?;
    drop(client);
    finish_task(worker_task).await?;
    Ok(result)
}

async fn benchmark_peer_socket(
    payload_bytes: usize,
    iterations: usize,
) -> Result<Measurement, SpikeError> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let address = listener.local_addr()?;
    let worker_task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await?;
        echo_framed(stream).await
    });
    let mut client = TcpStream::connect(address).await?;
    client.set_nodelay(true)?;
    let result = measure_framed(
        "server-pinned-peer-socket-lower-bound",
        &mut client,
        payload_bytes,
        iterations,
    )
    .await?;
    drop(client);
    finish_task(worker_task).await?;
    Ok(result)
}

async fn benchmark_webview_bridge(
    payload_bytes: usize,
    iterations: usize,
) -> Result<Measurement, SpikeError> {
    let worker_listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let worker_address = worker_listener.local_addr()?;
    let worker_task = tokio::spawn(async move {
        let (stream, _) = worker_listener.accept().await?;
        echo_framed(stream).await
    });

    let bridge_listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let bridge_address = bridge_listener.local_addr()?;
    let bridge_task = tokio::spawn(async move {
        let mut worker = TcpStream::connect(worker_address).await?;
        worker.set_nodelay(true)?;
        let (stream, _) = bridge_listener.accept().await?;
        let mut web_socket = accept_async(stream).await?;
        while let Some(message) = web_socket.next().await {
            match message? {
                Message::Binary(payload) => {
                    write_frame(&mut worker, &payload).await?;
                    let echoed = read_frame(&mut worker).await?;
                    web_socket.send(Message::Binary(echoed.into())).await?;
                }
                Message::Close(_) => break,
                Message::Ping(payload) => {
                    web_socket.send(Message::Pong(payload)).await?;
                }
                _ => {}
            }
        }
        Ok::<(), SpikeError>(())
    });

    let (mut client, _) = connect_async(format!("ws://{bridge_address}/worker-link")).await?;
    let payload = payload(payload_bytes);
    for _ in 0..8 {
        client.send(Message::Binary(payload.clone().into())).await?;
        expect_binary(client.next().await)?;
    }
    let mut samples = Vec::with_capacity(iterations);
    let total_started = Instant::now();
    for _ in 0..iterations {
        let started = Instant::now();
        client.send(Message::Binary(payload.clone().into())).await?;
        let echoed = expect_binary(client.next().await)?;
        if echoed.len() != payload_bytes {
            return Err("The WebView bridge benchmark returned a truncated frame.".into());
        }
        samples.push(started.elapsed());
    }
    let total = total_started.elapsed();
    client.close(None).await?;
    finish_task(bridge_task).await?;
    finish_task(worker_task).await?;
    Ok(measurement(
        "webview-bridge-plus-peer-hop-lower-bound",
        payload_bytes,
        iterations,
        samples,
        total,
    ))
}

async fn measure_framed<S>(
    topology: &'static str,
    stream: &mut S,
    payload_bytes: usize,
    iterations: usize,
) -> Result<Measurement, SpikeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let payload = payload(payload_bytes);
    for _ in 0..8 {
        write_frame(stream, &payload).await?;
        let echoed = read_frame(stream).await?;
        if echoed.len() != payload_bytes {
            return Err("The carrier benchmark returned a truncated warm-up frame.".into());
        }
    }
    let mut samples = Vec::with_capacity(iterations);
    let total_started = Instant::now();
    for _ in 0..iterations {
        let started = Instant::now();
        write_frame(stream, &payload).await?;
        let echoed = read_frame(stream).await?;
        if echoed.len() != payload_bytes {
            return Err("The carrier benchmark returned a truncated frame.".into());
        }
        samples.push(started.elapsed());
    }
    let total = total_started.elapsed();
    Ok(measurement(
        topology,
        payload_bytes,
        iterations,
        samples,
        total,
    ))
}

fn measurement(
    topology: &'static str,
    payload_bytes: usize,
    iterations: usize,
    mut samples: Vec<Duration>,
    total: Duration,
) -> Measurement {
    samples.sort_unstable();
    let p50 = samples[(samples.len() - 1) / 2].as_micros();
    let p95 = samples[((samples.len() - 1) * 95) / 100].as_micros();
    let useful_bytes = payload_bytes.saturating_mul(iterations) as f64;
    Measurement {
        topology,
        payload_bytes,
        iterations,
        p50_round_trip_micros: p50,
        p95_round_trip_micros: p95,
        useful_mib_per_second: useful_bytes / total.as_secs_f64() / (1_024.0 * 1_024.0),
    }
}

async fn echo_framed<S>(mut stream: S) -> Result<(), SpikeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let payload = match read_frame(&mut stream).await {
            Ok(payload) => payload,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        write_frame(&mut stream, &payload).await?;
    }
}

async fn write_frame<S>(stream: &mut S, payload: &[u8]) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let length = u32::try_from(payload.len())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "frame too large"))?;
    stream.write_all(&length.to_be_bytes()).await?;
    stream.write_all(payload).await?;
    stream.flush().await
}

async fn read_frame<S>(stream: &mut S) -> std::io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    let mut encoded_length = [0_u8; 4];
    stream.read_exact(&mut encoded_length).await?;
    let length = u32::from_be_bytes(encoded_length) as usize;
    if length > 2 * 1_024 * 1_024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "benchmark frame exceeded its bound",
        ));
    }
    let mut payload = vec![0_u8; length];
    stream.read_exact(&mut payload).await?;
    Ok(payload)
}

fn expect_binary(
    message: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) -> Result<Vec<u8>, SpikeError> {
    match message {
        Some(Ok(Message::Binary(payload))) => Ok(payload.to_vec()),
        Some(Ok(_)) => Err("The WebView bridge benchmark returned a non-binary frame.".into()),
        Some(Err(error)) => Err(error.into()),
        None => Err("The WebView bridge benchmark closed before returning a frame.".into()),
    }
}

async fn finish_task(task: JoinHandle<Result<(), SpikeError>>) -> Result<(), SpikeError> {
    task.await??;
    Ok(())
}

fn payload(length: usize) -> Vec<u8> {
    (0..length)
        .map(|index| ((index.wrapping_mul(31).wrapping_add(17)) & 0xff) as u8)
        .collect()
}
