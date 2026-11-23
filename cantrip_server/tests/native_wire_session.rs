use anyhow::{Result, ensure};
use futures::poll;
use std::time::Duration;

struct Release(std::path::PathBuf);
impl Drop for Release {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.0, b"release");
    }
}

fn query(sql: &str) -> Vec<u8> {
    let mut wire = vec![b'Q'];
    wire.extend_from_slice(&((sql.len() + 5) as u32).to_be_bytes());
    wire.extend_from_slice(sql.as_bytes());
    wire.push(0);
    wire
}
fn ready(response: &[u8]) -> Result<u8> {
    let mut cursor = 0;
    let mut status = None;
    while cursor < response.len() {
        ensure!(cursor + 5 <= response.len(), "truncated reply");
        let size = u32::from_be_bytes(response[cursor + 1..cursor + 5].try_into()?) as usize;
        ensure!(size >= 4 && cursor + size < response.len(), "invalid reply");
        if response[cursor] == b'Z' {
            status = Some(response[cursor + 5]);
        }
        cursor += size + 1;
    }
    status.ok_or_else(|| anyhow::anyhow!("no ReadyForQuery"))
}

#[tokio::test]
async fn exclusive_native_wire_session_rolls_back_before_releasing_waiters() -> Result<()> {
    let root = tempfile::tempdir()?;
    let db = pglite::PGlite::open(root.path().join("database")).await?;
    db.exec("CREATE TABLE wire_probe(value int)").await?;
    {
        let mut wire = db.wire_session().await;
        assert_eq!(ready(&wire.exchange(query("SELECT 1")).await?)?, b'I');
        assert_eq!(
            ready(
                &wire
                    .exchange(query("BEGIN; INSERT INTO wire_probe VALUES(1)"))
                    .await?
            )?,
            b'T'
        );
        let blocked = db.query("SELECT count(*)::int FROM wire_probe", &[]);
        tokio::pin!(blocked);
        assert!(
            poll!(&mut blocked).is_pending(),
            "ordinary queries wait for the complete session"
        );
        drop(wire);
        assert_eq!(
            blocked.await?[0].get::<i32>(0)?,
            0,
            "rollback precedes the waiting query"
        );
    }

    let witness = root.path().join("executed.txt");
    let release = Release(root.path().join("release.txt"));
    let sql = format!(
        "BEGIN; INSERT INTO wire_probe VALUES(2); COPY (SELECT 'entered') TO '{}'; DO $wait$ BEGIN LOOP EXIT WHEN (pg_stat_file('{}',true)).size IS NOT NULL; PERFORM pg_sleep(0.01); END LOOP; END $wait$",
        witness.display().to_string().replace('\'', "''"),
        release.0.display().to_string().replace('\'', "''")
    );
    let mut wire = db.wire_session().await;
    {
        let exchange = wire.exchange(query(&sql));
        tokio::pin!(exchange);
        tokio::select! {
            result = &mut exchange => panic!("exchange completed before its SQL witness was observed: {result:?}"),
            result = async {
                tokio::time::timeout(Duration::from_secs(10), async {
                    while !witness.try_exists().unwrap_or(false) { tokio::time::sleep(Duration::from_millis(5)).await; }
                }).await
            } => { result?; }
        }
        assert_eq!(std::fs::read_to_string(&witness)?.trim(), "entered");
        // Drop a genuinely executing exchange, then the session. The native
        // command finishes before its queued rollback and the next query.
    }
    drop(wire);
    std::fs::write(&release.0, b"release")?;
    assert_eq!(
        db.query("SELECT count(*)::int FROM wire_probe", &[])
            .await?[0]
            .get::<i32>(0)?,
        0
    );
    db.close().await?;
    Ok(())
}
