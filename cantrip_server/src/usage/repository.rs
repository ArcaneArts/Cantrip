use super::*;
use crate::database::{Database, Row};
use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, TimeZone, Timelike, Utc};
use num_bigint::BigInt;
use std::{collections::HashSet, sync::Arc};

pub const STORAGE_LEASE: &str = "full-storage-reconciliation";
pub const HISTORY_LEASE: &str = "usage-history-maintenance";
const LEASE_MS: i64 = 30 * 60_000;

#[derive(Debug)]
pub struct LeaseLost;
impl std::fmt::Display for LeaseLost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Storage reconciliation lease expired before projection update.")
    }
}
impl std::error::Error for LeaseLost {}

fn integer(row: &Row, column: usize) -> Result<BigInt> {
    Ok(row.get::<String>(column)?.parse()?)
}
fn owner_ids(mut owners: Vec<String>) -> Vec<String> {
    owners.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    owners.dedup();
    owners
}
pub(super) fn expiry(now: DateTime<Utc>, lease_ms: i64) -> Result<DateTime<Utc>> {
    now.checked_add_signed(
        chrono::Duration::try_milliseconds(lease_ms).context("invalid lease duration")?,
    )
    .context("invalid lease expiry")
}
/// Date.UTC retains its legacy 1900 adjustment for years 0 through 99.
pub fn calendar_bucket(value: DateTime<Utc>, day: bool) -> Result<DateTime<Utc>> {
    let year = value.year();
    let year = if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    let start = Utc
        .with_ymd_and_hms(
            year,
            value.month(),
            1,
            if day { 0 } else { value.hour() },
            0,
            0,
        )
        .single()
        .context("invalid accounting calendar bucket")?;
    start
        .checked_add_signed(chrono::Duration::days(i64::from(value.day() - 1)))
        .context("invalid accounting calendar bucket")
}

#[derive(Clone)]
pub struct UsageRepository {
    pub database: Arc<Database>,
}
impl UsageRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }

    pub async fn measure_storage(&self) -> Result<Vec<StorageMeasurement>> {
        self.database
            .query(measurement_sql(), &[])
            .await?
            .iter()
            .map(|row| {
                Ok(StorageMeasurement {
                    owner_id: row.get(0)?,
                    storage_class: row.get(1)?,
                    category: row.get(2)?,
                    logical_bytes: integer(row, 3)?,
                    row_count: integer(row, 4)?,
                })
            })
            .collect()
    }
    pub async fn current_storage(&self, owner: &str) -> Result<Vec<CurrentStorage>> {
        self.database.query("SELECT category,logical_bytes::text,owner_id,row_count::text,storage_class,basis_version,measured_at,reconciled_at FROM account_storage_usage_current WHERE owner_id=$1 ORDER BY storage_class,category", &[&owner]).await?.iter().map(|row| Ok(CurrentStorage {
            measurement: StorageMeasurement { category: row.get(0)?, logical_bytes: integer(row,1)?, owner_id: row.get(2)?, row_count: integer(row,3)?, storage_class: row.get(4)? },
            basis_version: row.get(5)?, measured_at: row.get(6)?, reconciled_at: row.get(7)?,
        })).collect()
    }
    pub async fn storage_history(
        &self,
        owner: &str,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        hourly: bool,
    ) -> Result<Vec<StorageHistory>> {
        let query = if hourly {
            "SELECT bucket_start,category,logical_bytes::text,row_count::text,storage_class FROM account_storage_usage_snapshots WHERE owner_id=$1 AND resolution='hour' AND bucket_start >= $2 AND bucket_start < $3 ORDER BY bucket_start,storage_class,category"
        } else {
            "SELECT bucket_start,category,logical_bytes::text,row_count::text,storage_class FROM (SELECT date_trunc('day',bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,category,logical_bytes,row_count,storage_class,row_number() OVER (PARTITION BY date_trunc('day',bucket_start AT TIME ZONE 'UTC'),storage_class,category ORDER BY measured_at DESC,bucket_start DESC) AS recency FROM account_storage_usage_snapshots WHERE owner_id=$1 AND resolution IN ('hour','day') AND bucket_start >= $2 AND bucket_start < $3) daily WHERE recency=1 ORDER BY bucket_start,storage_class,category"
        };
        self.database
            .query(query, &[&owner, &from, &to])
            .await?
            .iter()
            .map(|row| {
                Ok(StorageHistory {
                    bucket_start: row.get(0)?,
                    category: row.get(1)?,
                    logical_bytes: integer(row, 2)?,
                    row_count: integer(row, 3)?,
                    storage_class: row.get(4)?,
                })
            })
            .collect()
    }
    pub async fn bandwidth_history(
        &self,
        owner: &str,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        hourly: bool,
    ) -> Result<Vec<BandwidthHistory>> {
        let bucket = if hourly {
            "bucket_start"
        } else {
            "date_trunc('day',bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
        };
        let filter = if hourly {
            "resolution='hour'"
        } else {
            "resolution IN ('hour','day')"
        };
        let query = format!(
            "SELECT {bucket} AS bucket_start,sum(bytes)::text,channel,direction,sum(operation_count)::text,max(updated_at) FROM account_bandwidth_usage_buckets WHERE owner_id=$1 AND {filter} AND bucket_start >= $2 AND bucket_start < $3 GROUP BY {bucket},channel,direction ORDER BY bucket_start,channel,direction"
        );
        self.database
            .query(&query, &[&owner, &from, &to])
            .await?
            .iter()
            .map(|row| {
                Ok(BandwidthHistory {
                    bucket_start: row.get(0)?,
                    bytes: integer(row, 1)?,
                    channel: row.get(2)?,
                    direction: row.get(3)?,
                    operation_count: integer(row, 4)?,
                    updated_at: row.get(5)?,
                })
            })
            .collect()
    }
    pub async fn flush_bandwidth(&self, batch: FlushBatch) -> Result<FlushResult> {
        if batch.entries.is_empty() {
            return Ok(FlushResult {
                applied: false,
                owner_ids: vec![],
            });
        }
        self.database.transaction(move |tx| Box::pin(async move {
            let requested: Vec<_> = batch.entries.iter().map(|e| e.owner_id.clone()).collect::<HashSet<_>>().into_iter().collect();
            let rows = tx.query("SELECT id FROM users WHERE id=ANY($1::text[])", &[&requested]).await?;
            let owners = owner_ids(rows.iter().map(|r| r.get(0)).collect::<Result<Vec<String>>>()?);
            let total: BigInt = batch.entries.iter().map(|e| &e.bytes).sum();
            let inserted = tx.query("INSERT INTO account_bandwidth_flushes(meter_id,sequence,entry_count,bytes,flushed_at) VALUES($1,($2::text)::bigint,($3::text)::integer,($4::text)::bigint,$5) ON CONFLICT DO NOTHING RETURNING meter_id", &[&batch.meter_id,&batch.sequence.to_string(),&batch.entries.len().to_string(),&total.to_string(),&batch.flushed_at]).await?;
            if inserted.is_empty() { return Ok(FlushResult { applied: false, owner_ids: owners }); }
            let active: HashSet<_> = owners.iter().collect();
            let entries: Vec<_> = batch.entries.into_iter().filter(|e| active.contains(&e.owner_id)).collect();
            if !entries.is_empty() {
                let input = serde_json::to_value(entries)?;
                // One insert preserves PostgreSQL's duplicate-key rejection for
                // repeated entries within one batch, including full rollback.
                tx.query("INSERT INTO account_bandwidth_usage_buckets(owner_id,bucket_start,resolution,channel,direction,bytes,operation_count,updated_at) SELECT e.\"ownerId\",e.\"bucketStart\",'hour',e.channel,e.direction,e.bytes,e.\"operationCount\",$2 FROM jsonb_to_recordset($1::jsonb) AS e(\"ownerId\" text,\"bucketStart\" timestamptz,channel text,direction text,bytes bigint,\"operationCount\" bigint) ON CONFLICT(owner_id,bucket_start,resolution,channel,direction) DO UPDATE SET bytes=account_bandwidth_usage_buckets.bytes+excluded.bytes,operation_count=account_bandwidth_usage_buckets.operation_count+excluded.operation_count,updated_at=$2", &[&input,&batch.flushed_at]).await?;
            }
            Ok(FlushResult { applied: true, owner_ids: owners })
        })).await
    }
    pub async fn acquire_lease(
        &self,
        key: &str,
        holder: &str,
        now: DateTime<Utc>,
        lease_ms: i64,
    ) -> Result<bool> {
        if key.trim_matches(crate::text::whitespace).is_empty()
            || holder.trim_matches(crate::text::whitespace).is_empty()
            || lease_ms < 1
        {
            return Ok(false);
        }
        let expires = expiry(now, lease_ms)?;
        Ok(self.database.query("INSERT INTO account_storage_reconciliation_leases(key,holder_id,expires_at,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(key) DO UPDATE SET holder_id=excluded.holder_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at WHERE account_storage_reconciliation_leases.expires_at <= $4 OR account_storage_reconciliation_leases.holder_id=$2 RETURNING key", &[&key,&holder,&expires,&now]).await?.len()==1)
    }
    pub async fn release_lease(&self, key: &str, holder: &str) -> Result<()> {
        self.database
            .query(
                "DELETE FROM account_storage_reconciliation_leases WHERE key=$1 AND holder_id=$2",
                &[&key, &holder],
            )
            .await?;
        Ok(())
    }
    pub async fn reconcile_storage(
        &self,
        holder: &str,
        measured_at: DateTime<Utc>,
    ) -> Result<ReconciliationResult> {
        let acquired = self
            .acquire_lease(STORAGE_LEASE, holder, crate::auth::now(), LEASE_MS)
            .await?;
        let empty = ReconciliationResult {
            acquired,
            account_count: 0,
            category_count: 0,
            logical_bytes: BigInt::default(),
            measured_at,
            owner_ids: vec![],
            row_count: BigInt::default(),
        };
        if !acquired {
            return Ok(empty);
        }
        let result = self.reconcile_acquired(holder, measured_at).await;
        // Match the reference finally block, including release on a failed
        // measurement or transaction. Never clear another holder's lease.
        self.release_lease(STORAGE_LEASE, holder).await?;
        result
    }
    async fn reconcile_acquired(
        &self,
        holder: &str,
        measured_at: DateTime<Utc>,
    ) -> Result<ReconciliationResult> {
        let measurements = self.measure_storage().await?;
        let reconciled_at = crate::auth::now();
        let bucket = calendar_bucket(measured_at, false)?;
        let holder = holder.to_owned();
        let input = serde_json::to_value(&measurements)?;
        let empty = measurements.is_empty();
        self.database.transaction(move |tx| Box::pin(async move {
            let rows = tx.query("UPDATE account_storage_reconciliation_leases SET expires_at=$3,updated_at=$4 WHERE key=$1 AND holder_id=$2 AND expires_at > $4 RETURNING key", &[&STORAGE_LEASE,&holder,&expiry(reconciled_at,LEASE_MS)?,&reconciled_at]).await?;
            if rows.len()!=1 { return Err(LeaseLost.into()); }
            tx.query("DELETE FROM account_storage_usage_current",&[]).await?;
            if empty { return Ok(()); }
            tx.query("INSERT INTO account_storage_usage_current(owner_id,storage_class,category,logical_bytes,row_count,basis_version,measured_at,reconciled_at) SELECT e.\"ownerId\",e.\"storageClass\",e.category,e.\"logicalBytes\",e.\"rowCount\",$2,$3,$4 FROM jsonb_to_recordset($1::jsonb) AS e(\"ownerId\" text,\"storageClass\" text,category text,\"logicalBytes\" bigint,\"rowCount\" bigint)",&[&input,&basis_version(),&measured_at,&reconciled_at]).await?;
            tx.query("INSERT INTO account_storage_usage_snapshots(owner_id,bucket_start,resolution,storage_class,category,logical_bytes,row_count,basis_version,measured_at,created_at,updated_at) SELECT e.\"ownerId\",$2,'hour',e.\"storageClass\",e.category,e.\"logicalBytes\",e.\"rowCount\",$3,$4,$5,$5 FROM jsonb_to_recordset($1::jsonb) AS e(\"ownerId\" text,\"storageClass\" text,category text,\"logicalBytes\" bigint,\"rowCount\" bigint) ON CONFLICT(owner_id,bucket_start,resolution,storage_class,category) DO UPDATE SET logical_bytes=excluded.logical_bytes,row_count=excluded.row_count,basis_version=excluded.basis_version,measured_at=excluded.measured_at,updated_at=$5", &[&input,&bucket,&basis_version(),&measured_at,&reconciled_at]).await?;
            Ok(())
        })).await?;
        let owners = owner_ids(measurements.iter().map(|m| m.owner_id.clone()).collect());
        Ok(ReconciliationResult {
            acquired: true,
            account_count: owners.len(),
            category_count: measurements.len(),
            logical_bytes: measurements.iter().map(|m| &m.logical_bytes).sum(),
            measured_at,
            owner_ids: owners,
            row_count: measurements.iter().map(|m| &m.row_count).sum(),
        })
    }
}
