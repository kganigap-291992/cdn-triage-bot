# RUNBOOK --- Cachey ClickHouse Debug Pipeline (Public-Safe)

This document is a quick operational reference for diagnosing issues in
the Cachey ClickHouse-based debug and triage pipeline.

All sensitive information (hosts, credentials, API keys) is
intentionally omitted. Use environment variables and secret managers for
private values.

------------------------------------------------------------------------

## Scope

This runbook covers:

-   ClickHouse Docker health
-   Database sanity checks
-   SQL validation
-   `/api/triage` debugging
-   Filter and partner verification

It does NOT include credentials or private endpoints.

------------------------------------------------------------------------

## What "Healthy" Looks Like

A healthy system satisfies all of the following:

-   ClickHouse container is running
-   `cachey.raw_minute` exists and contains rows
-   `max(ts)` reflects latest ingestion
-   `/api/triage` returns `ok: true`
-   SQL output begins with `SELECT`
-   Debug output shows mapped DB partner

------------------------------------------------------------------------

## 1. Docker Health (ClickHouse)

### 1.1 List Containers

``` bash
docker ps
```

Expected: - ClickHouse container is `Up`

------------------------------------------------------------------------

### 1.2 View Logs

``` bash
docker logs --tail 100 <CLICKHOUSE_CONTAINER>
```

Expected: - No repeated crash loops - No fatal errors

------------------------------------------------------------------------

### 1.3 Enter ClickHouse Client

``` bash
docker exec -it <CLICKHOUSE_CONTAINER> clickhouse-client
```

------------------------------------------------------------------------

## 2. Database Sanity Checks

Run inside `clickhouse-client`.

------------------------------------------------------------------------

### 2.1 Schema Verification

``` sql
USE cachey;
DESCRIBE TABLE raw_minute;
```

Expected columns include:

-   ts
-   partner
-   content_type
-   ua_family
-   requests
-   http_5xx_count
-   p95_ms
-   p99_ms

------------------------------------------------------------------------

### 2.2 Row Count

``` sql
SELECT count() FROM cachey.raw_minute;
```

Expected: - Count \> 0

------------------------------------------------------------------------

### 2.3 Data Freshness

``` sql
SELECT
  max(ts) AS max_ts,
  min(ts) AS min_ts,
  now() AS now_ts,
  dateDiff('minute', max(ts), now()) AS minutes_behind_now
FROM cachey.raw_minute;
```

Interpretation:

-   Large `minutes_behind_now` = ingestion delayed
-   Debug mode anchors to `max(ts)`

------------------------------------------------------------------------

### 2.4 Known Partners

``` sql
SELECT partner, count() AS rows
FROM cachey.raw_minute
GROUP BY partner
ORDER BY rows DESC
LIMIT 20;
```

Expected: - Values like `partner_01`, `partner_02`, etc.

------------------------------------------------------------------------

### 2.5 Dimension Distribution

``` sql
SELECT content_type, ua_family, count()
FROM cachey.raw_minute
GROUP BY content_type, ua_family
ORDER BY count() DESC
LIMIT 25;
```

Expected: - content_type: manifest\|segment\|api - ua_family:
web\|mobile\|stb\|smart_tv\|console

------------------------------------------------------------------------

## 3. Truth Query (Direct ClickHouse)

Use anchored windows for stale ingestion.

``` sql
SELECT
  sum(requests) AS total_requests,
  sum(http_5xx_count) AS http_5xx,
  avg(p99_ms) AS p99_ms
FROM cachey.raw_minute
WHERE partner = '<DB_PARTNER>'
  AND ts >= (SELECT max(ts) FROM cachey.raw_minute) - INTERVAL 60 MINUTE
  AND content_type = 'manifest'
  AND ua_family = 'web';
```

Expected: - Non-zero totals - p99_ms is numeric

------------------------------------------------------------------------

## 4. Local API Verification

Assumes UI server running on localhost.

------------------------------------------------------------------------

### 4.1 Partner Requirement

``` bash
curl -sS -i -X POST "http://localhost:3000/api/triage"   -H "Content-Type: application/json"   -d '{"dataSource":"clickhouse","service":"all"}'
```

Expected: - HTTP 400 - Partner required error

------------------------------------------------------------------------

### 4.2 SQL Generation

``` bash
curl -sS -X POST "http://localhost:3000/api/triage"   -H "Content-Type: application/json"   -d '{"dataSource":"clickhouse","partner":"<UI_PARTNER>","debug":true}' | jq '{ok:.ok, firstLine:(.sql.queries[0]|split("\n")[0])}'
```

Expected: - ok = true - firstLine = SELECT

------------------------------------------------------------------------

### 4.3 Mapping + Anchoring

``` bash
curl -sS -X POST "http://localhost:3000/api/triage"   -H "Content-Type: application/json"   -d '{"dataSource":"clickhouse","partner":"<UI_PARTNER>","debug":true}' | jq '{
  partnerParam:(.sql.params.partner // null),
  usesMaxTs:(.sql.queries[0]|contains("SELECT max(ts)")),
  dbg:(.metricsJson.debug // {})
}'
```

Expected: - partnerParam is DB ID - usesMaxTs = true - dbg.dbPartner
present

------------------------------------------------------------------------

## 5. Common Failure Patterns

### 5.1 Zero Results

Possible causes: - Ingestion stalled - Partner mismatch - Window too
small

Actions: - Check section 2.3 - Verify section 2.4 - Use anchored queries

------------------------------------------------------------------------

### 5.2 Mock SQL Appears

Possible causes: - sqlBuilder not used - Runner misconfigured

Actions: - Inspect runClickhouseTriage - Verify imports

------------------------------------------------------------------------

### 5.3 Filters Not Applied

Possible causes: - Params missing - WHERE clause incorrect

Actions: - Inspect `.sql.params` - Inspect `.sql.queries[0]`

------------------------------------------------------------------------

## 6. Security Guidelines

Never commit:

-   API keys
-   Passwords
-   Internal IPs
-   Private domains
-   Proxy secrets

Always use:

-   Environment variables
-   Secret managers
-   Placeholders in docs

------------------------------------------------------------------------

## 7. Recovery Workflow (Minimal)

1.  Check Docker
2.  Check max(ts)
3.  Run truth query
4.  Run curl tests
5.  Inspect SQL + params
6.  Fix mapping/windowing

Most incidents should be diagnosable in \<15 minutes using this flow.

------------------------------------------------------------------------

## Status

Public-safe operational reference. No secrets stored. 
