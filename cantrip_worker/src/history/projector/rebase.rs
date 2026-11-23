//! Canonical floors plus all retained local source through the rejected page's
//! immutable endpoint. Replay is pure; preparation happens once after replay.
use super::*;
use cantrip_history::source::Journal;
pub fn replay(
    binding: Value,
    recovery: Value,
    source: Journal,
    through: Value,
    projector: Projector,
    signal: Option<Signal>,
) -> Work<Projected> {
    owned(async move {
        let mut state = bootstrap::restore(&recovery)?;
        let mut sequence = 0;
        let mut last = Value::Null;
        let end = through["sequence"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("Invalid native history rebase endpoint."))?;
        while sequence < end {
            if let Some(signal) = &signal {
                signal.check()?;
            }
            let records = source.read(sequence, (end - sequence).min(512)).await?;
            if records.is_empty()
                || records[0]["sequence"].as_u64() != Some(sequence + 1)
                || records.last().unwrap()["sequence"]
                    .as_u64()
                    .is_none_or(|s| s > end)
            {
                bail!("Native history rebase replay is missing its retained source range.");
            }
            state["source"] = reducer::reduce(
                Some(&state["source"]),
                &records,
                text(&binding["threadId"])?,
            )?;
            sequence = records.last().unwrap()["sequence"].as_u64().unwrap();
            last = records.last().unwrap()["recordId"].clone();
        }
        if last != through["recordId"] {
            bail!("Native history rebase replay changed its original endpoint.");
        }
        if let Some(signal) = &signal {
            signal.check()?;
        }
        projector.project(Vec::new(), state).await
    })
}
pub fn recover(
    binding: Value,
    client: Client,
    service: Arc<dyn Encryption>,
    source: Journal,
    through: Value,
    projector: Projector,
    signal: Option<Signal>,
) -> Work<Projected> {
    owned(async move {
        let recovered = super::super::recovery::read(
            &binding,
            client,
            service,
            super::super::recovery::Options {
                signal: signal.clone(),
                ..Default::default()
            },
        )
        .await?;
        replay(binding, recovered, source, through, projector, signal).await
    })
}
