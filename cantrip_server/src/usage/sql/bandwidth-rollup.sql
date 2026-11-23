WITH daily AS (
  SELECT owner_id,
    date_trunc('day', bucket_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
    channel, direction, sum(bytes)::bigint AS bytes,
    sum(operation_count)::bigint AS operation_count, max(updated_at) AS updated_at
  FROM account_bandwidth_usage_buckets
  WHERE resolution = 'hour' AND bucket_start >= $2 AND bucket_start < $3
  GROUP BY owner_id, date_trunc('day', bucket_start AT TIME ZONE 'UTC'), channel, direction
), upserted AS (
  INSERT INTO account_bandwidth_usage_buckets
    (owner_id, bucket_start, resolution, channel, direction, bytes, operation_count, created_at, updated_at)
  SELECT owner_id, bucket_start, 'day', channel, direction, bytes, operation_count, $1, updated_at
  FROM daily
  ON CONFLICT (owner_id, bucket_start, resolution, channel, direction)
  DO UPDATE SET bytes = account_bandwidth_usage_buckets.bytes + excluded.bytes,
    operation_count = account_bandwidth_usage_buckets.operation_count + excluded.operation_count,
    updated_at = excluded.updated_at
  RETURNING 1
) SELECT count(*)::text FROM upserted
