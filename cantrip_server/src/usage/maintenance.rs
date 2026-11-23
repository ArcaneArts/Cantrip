use super::{
    repository::{HISTORY_LEASE, LeaseLost, UsageRepository, calendar_bucket, expiry},
    *,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use num_bigint::BigInt;

fn cutoff(now: DateTime<Utc>, days: i64) -> Result<DateTime<Utc>> {
    now.checked_sub_signed(chrono::Duration::try_days(days).context("invalid history retention")?)
        .context("invalid history retention cutoff")
}
impl UsageRepository {
    pub async fn operational_totals(&self) -> Result<OperationalTotals> {
        let rows = self.database.query("SELECT count(DISTINCT owner_id)::text,coalesce(sum(logical_bytes) FILTER (WHERE storage_class='server'),0)::text,coalesce(sum(logical_bytes) FILTER (WHERE storage_class='worker-managed'),0)::text FROM account_storage_usage_current",&[]).await?;
        let row = rows.first().context("accounting totals")?;
        let physical = async {
            let rows = self
                .database
                .query("SELECT pg_database_size(current_database())::text", &[])
                .await?;
            rows.first()
                .context("database size")?
                .get::<String>(0)?
                .parse::<BigInt>()
                .map_err(anyhow::Error::from)
        }
        .await
        .ok();
        Ok(OperationalTotals {
            account_count: row.get::<String>(0)?.parse()?,
            logical_server_bytes: row.get::<String>(1)?.parse()?,
            logical_worker_managed_bytes: row.get::<String>(2)?.parse()?,
            physical_database_bytes: physical,
        })
    }
    pub async fn maintain_history(
        &self,
        holder: &str,
        now: DateTime<Utc>,
        options: HistoryOptions,
    ) -> Result<MaintenanceResult> {
        let safe = |n: i64| (1..=9_007_199_254_740_991).contains(&n);
        anyhow::ensure!(
            safe(options.hourly_retention_days)
                && safe(options.daily_retention_days)
                && options.daily_retention_days > options.hourly_retention_days
                && safe(options.flush_retention_days),
            "Account usage history maintenance options are invalid."
        );
        let acquired = self
            .acquire_lease(HISTORY_LEASE, holder, now, options.lease_ms)
            .await?;
        if !acquired {
            return Ok(MaintenanceResult::default());
        }
        let result = self.maintain_acquired(holder, now, options).await;
        self.release_lease(HISTORY_LEASE, holder).await?;
        result
    }
    async fn maintain_acquired(
        &self,
        holder: &str,
        now: DateTime<Utc>,
        options: HistoryOptions,
    ) -> Result<MaintenanceResult> {
        let hourly = calendar_bucket(cutoff(now, options.hourly_retention_days)?, true)?;
        let daily = calendar_bucket(cutoff(now, options.daily_retention_days)?, true)?;
        let flush = cutoff(now, options.flush_retention_days)?;
        let holder = holder.to_owned();
        self.database.transaction(move |tx| Box::pin(async move {
            let rows = tx.query("UPDATE account_storage_reconciliation_leases SET expires_at=$3,updated_at=$4 WHERE key=$1 AND holder_id=$2 AND expires_at > $4 RETURNING key", &[&HISTORY_LEASE,&holder,&expiry(now,options.lease_ms)?,&now]).await?;
            if rows.len()!=1 { return Err(LeaseLost.into()); }
            let bandwidth = tx.query(include_str!("sql/bandwidth-rollup.sql"),&[&now,&daily,&hourly]).await?;
            let storage = tx.query(include_str!("sql/storage-rollup.sql"),&[&now,&daily,&hourly]).await?;
            let bandwidth_hours = tx.query("DELETE FROM account_bandwidth_usage_buckets WHERE resolution='hour' AND bucket_start < $1 RETURNING owner_id",&[&hourly]).await?;
            let storage_hours = tx.query("DELETE FROM account_storage_usage_snapshots WHERE resolution='hour' AND bucket_start < $1 RETURNING owner_id",&[&hourly]).await?;
            let bandwidth_days = tx.query("DELETE FROM account_bandwidth_usage_buckets WHERE resolution='day' AND bucket_start < $1 RETURNING owner_id",&[&daily]).await?;
            let storage_days = tx.query("DELETE FROM account_storage_usage_snapshots WHERE resolution='day' AND bucket_start < $1 RETURNING owner_id",&[&daily]).await?;
            let flushes = tx.query("DELETE FROM account_bandwidth_flushes WHERE flushed_at < $1 RETURNING meter_id",&[&flush]).await?;
            Ok(MaintenanceResult { acquired:true,bandwidth_daily_rows_deleted:bandwidth_days.len(),bandwidth_days_rolled:bandwidth.first().context("bandwidth rollup count")?.get::<String>(0)?.parse()?,bandwidth_hourly_rows_deleted:bandwidth_hours.len(),flush_rows_deleted:flushes.len(),storage_daily_rows_deleted:storage_days.len(),storage_days_rolled:storage.first().context("storage rollup count")?.get::<String>(0)?.parse()?,storage_hourly_rows_deleted:storage_hours.len() })
        })).await
    }
}
