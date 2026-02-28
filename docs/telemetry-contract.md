# Telemetry Contract (Frozen)

This contract defines the canonical telemetry schema used by Cachey and the ML repo.

**Rule:** Never rename columns. Only add new columns (additive evolution).

## Layers

### 1) raw_minute (generator output)

Minute-level event rows. Highest fidelity.

Required columns (minimum): - ts_minute (ISO or epoch minute) -
partner - service (live\|vod) - region - pop - path - path_type
(manifest\|segment\|other) - ua_family - status_code - cache_status
(hit\|miss\|pass) - ttms_ms

Additive columns allowed: - http_200_count (if represented as counts) OR
derive via status_code=200

------------------------------------------------------------------------

### 2) buckets_5m (aggregated for graphs)

Graph-ready 5-minute buckets.

Required columns (minimum): - bucket_5m_start - partner - service -
region - pop - requests - http_200_count - http_4xx_count -
http_5xx_count - cache_hit_count - cache_miss_count - p95_ttms_ms -
p99_ttms_ms

------------------------------------------------------------------------

### 3) features_5m (ML frame)

Model-ready feature table derived from buckets_5m.

Required columns (minimum): - bucket_5m_start - partner - service -
region - pop - (feature columns derived from buckets)

Note: Some ops fields may be excluded from features initially.

------------------------------------------------------------------------

### 4) scores_zscore (ML outputs)

Outputs of anomaly detection.

Required columns (minimum): - bucket_5m_start - partner - service -
region - pop - score_z - is_anomaly

------------------------------------------------------------------------

# Telemetry Contract v2 --- Production ClickHouse (Frozen)

This contract defines the canonical ClickHouse schema currently deployed
in production by Cachey.

**Rule:** Columns are frozen. Only additive evolution allowed.\*\*

Table:

    cachey.raw_minute

## Required Columns

### Identity / Scope

-   ts (DateTime) --- minute timestamp
-   partner (LowCardinality(String))
-   service (live\|vod\|dvr\|eas\|live_ott\|app_backend)
-   region
-   pop
-   host
-   content_type (manifest\|segment\|api)
-   ua_family (stb\|mobile\|web\|smart_tv\|console)

### Traffic

-   requests (UInt32)
-   bytes_sent (UInt64)

### Latency

-   p50_ms (Float32)
-   p95_ms (Float32)
-   p99_ms (Float32)

### Error Counters

-   http_2xx_count
-   http_3xx_count
-   http_4xx_count
-   http_5xx_count

### Status Breakouts

-   status_200
-   status_206
-   status_304
-   status_403
-   status_404
-   status_429
-   status_500
-   status_502
-   status_503
-   status_504

### Cache

-   cache_hit_rate (Float32)

### Edge / System

-   crc_errors (UInt32)

------------------------------------------------------------------------

## Triage Query Contract

The triage API aggregates:

-   sum(requests)
-   avg(p50_ms)
-   avg(p95_ms)
-   avg(p99_ms)
-   sum(http_5xx_count)

Filtered by:

-   partner (required)
-   service (required, cannot be "all")
-   region (all \| canonical region)
-   pop (all \| canonical pop)
-   content_type (all \| manifest \| segment \| api)
-   ua_family (all \| stb \| mobile \| web \| smart_tv \| console)
-   windowMinutes

------------------------------------------------------------------------

## Production Architecture

    Vercel UI
      → /api/triage
        → Caddy (TLS + Basic Auth)
          → cachey-proxy (Node, localhost:8787)
            → ClickHouse (localhost:8123)

Security: - ClickHouse bound to 127.0.0.1 - Proxy bound to 127.0.0.1 -
Only Caddy exposed on :443 - Secrets stored in /etc/cachey/proxy.env
(not in repo)


### 3) features_5m (ML frame)
Model-ready feature table derived from buckets_5m.

Required columns (minimum):
- bucket_5m_start
- partner
- service
- region
- pop
- (feature columns derived from buckets)

Note: Some ops fields may be excluded from features initially (documented here).

### 4) scores_zscore (ML outputs)
Outputs of anomaly detection.

Required columns (minimum):
- bucket_5m_start
- partner
- service
- region
- pop
- score_z
- is_anomaly

## Production Usage

This generator is consumed by Cachey.

For full infrastructure deployment and ingestion pipeline,
see the Cachey repository:
https://github.com/kganigap-291992/cdn-triage-bot