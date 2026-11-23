WITH ranked AS (
  SELECT owner_id,
    date_trunc('day', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
    storage_class, category, logical_bytes, row_count, basis_version, measured_at, updated_at,
    row_number() OVER (
      PARTITION BY owner_id, date_trunc('day', bucket_start AT TIME ZONE 'UTC'), storage_class, category
      ORDER BY bucket_start DESC, measured_at DESC
    ) AS recency
  FROM account_storage_usage_snapshots
  WHERE resolution = 'hour' AND bucket_start >= $2 AND bucket_start < $3
), upserted AS (
  INSERT INTO account_storage_usage_snapshots
    (owner_id, bucket_start, resolution, storage_class, category, logical_bytes, row_count, basis_version, measured_at, created_at, updated_at)
  SELECT owner_id, bucket_start, 'day', storage_class, category, logical_bytes, row_count, basis_version, measured_at, $1, updated_at
  FROM ranked WHERE recency = 1
  ON CONFLICT (owner_id, bucket_start, resolution, storage_class, category)
  DO UPDATE SET
    logical_bytes = CASE WHEN excluded.measured_at > account_storage_usage_snapshots.measured_at THEN excluded.logical_bytes ELSE account_storage_usage_snapshots.logical_bytes END,
    row_count = CASE WHEN excluded.measured_at > account_storage_usage_snapshots.measured_at THEN excluded.row_count ELSE account_storage_usage_snapshots.row_count END,
    basis_version = CASE WHEN excluded.measured_at > account_storage_usage_snapshots.measured_at THEN excluded.basis_version ELSE account_storage_usage_snapshots.basis_version END,
    measured_at = greatest(account_storage_usage_snapshots.measured_at, excluded.measured_at),
    updated_at = greatest(account_storage_usage_snapshots.updated_at, excluded.updated_at)
  RETURNING 1
) SELECT count(*)::text FROM upserted
