# Cachey Design Decisions --- 2026-02-23 (Debug + ClickHouse Integration)

## Context

This document captures the architectural and implementation decisions
made while stabilizing the Cachey debug pipeline and integrating it with
ClickHouse.

The goal of this phase was to ensure that all filters, SQL generation,
and debug tooling were deterministic and production-aligned before
enabling real database execution.

------------------------------------------------------------------------

## 1. Debug UI is ClickHouse-Only

**Decision** - Removed CSV upload and CSV URL support from `/debug` UI.

**Why** - CSV path is legacy and diverges from real production
behavior. - Debug must validate the ClickHouse pipeline.

**Impact** - `/debug` now tests real schema, filters, and SQL
generation.

------------------------------------------------------------------------

## 2. API Contract Extended with Generator Dimensions

**Decision** - Added `contentType` and `uaFamily` to `/api/triage`.

**Why** - These dimensions exist in generator output and ClickHouse
schema. - Required for meaningful triage.

**Impact** - End-to-end consistency: UI → API → SQL → DB.

------------------------------------------------------------------------

## 3. Partner Required in ClickHouse Mode

**Decision** - Enforced `partner` as mandatory when
`dataSource=clickhouse`.

**Why** - Prevent silent default queries. - Avoid misleading results.

**Impact** - All ClickHouse queries are explicitly scoped.

------------------------------------------------------------------------

## 4. Stable SQL Response Contract

**Decision** - API always returns `sql.queries` as non-null strings.

**Why** - Debug tooling and UI depend on stable output. - Prevents jq/UI
crashes.

**Impact** - Deterministic debugging and automation.

------------------------------------------------------------------------

## 5. Canonical SQL Builder Module

**Decision** - Introduced `lib/clickhouse/sqlBuilder.ts`.

**Why** - Centralize SQL generation. - Prevent scattered query logic.

**Impact** - Single source of truth for ClickHouse queries.

------------------------------------------------------------------------

## 6. SQL Builder Targets Real VPS Schema

**Decision** - Builder uses existing `cachey.raw_minute` schema.

**Why** - VPS already contained 2.88M rows. - Avoid parallel/unused
schemas.

**Impact** - Queries work against production-style data immediately.

------------------------------------------------------------------------

## 7. Debug-Time Anchoring to max(ts)

**Decision** - In debug mode, time windows anchor to `max(ts)` instead
of `now()`.

**Why** - Ingestion is not always continuous. - `now()` windows
frequently returned empty sets.

**Impact** - Debug always reflects latest available data.

------------------------------------------------------------------------

## 8. Partner Mapping (UI → DB)

**Decision** - Map UI-friendly names (e.g. `beta_stream`) to DB IDs
(`partner_01`).

**Why** - DB uses synthetic partner IDs. - UI requires readable names.

**Impact** - UI remains stable while DB evolves.

------------------------------------------------------------------------

## 9. SQL Always Generated in Runner

**Decision** - `runClickhouseTriage` always builds SQL via `sqlBuilder`.

**Why** - Prevent mock SQL from hiding wiring issues.

**Impact** - Curl/debug proves correctness without DB access.

------------------------------------------------------------------------

## 10. Mock Runner as Metrics Placeholder

**Decision** - Keep `runMockClickhouseTriage` only for fake metrics.

**Why** - Public repo safety. - Maintain UI rendering.

**Impact** - SQL remains authoritative.

------------------------------------------------------------------------

## 11. Debug Introspection Fields

**Decision** - Added debug fields: - `partner` - `dbPartner` -
`anchorToMaxTs` - execution notes

**Why** - Eliminate guesswork during debugging.

**Impact** - Faster diagnosis of zero/invalid results.

------------------------------------------------------------------------

## 12. Verified Wiring with Automated Tests

**Decision** - Use curl + jq for verification.

**Why** - CLI-level tests are repeatable. - Prevent regressions.

**Impact** - Stable debugging workflow.

------------------------------------------------------------------------

## Meta Architecture Principle

> Deterministic metrics first. AI later.

All infrastructure, SQL, and filters must be verifiable before adding
LLM reasoning.

------------------------------------------------------------------------

# Next Steps --- Enabling Real Execution via Caddy Proxy

## Goal

Enable secure execution of ClickHouse queries through VPS proxy without
exposing ClickHouse publicly.

------------------------------------------------------------------------

## Step 1: Add Query Endpoint to VPS Proxy

### Endpoint

POST /v1/query

### Input

``` json
{
  "query": "SELECT ...",
  "params": { "partner": "partner_01" }
}
```

### Output

``` json
{
  "rows": [ ... ]
}
```

### Requirements

-   Execute against localhost ClickHouse.
-   Validate API key.
-   Log queries for auditing.

------------------------------------------------------------------------

## Step 2: Secure with API Key

-   Generate secret key.
-   Require header: x-cachey-key: `<SECRET>`{=html}
-   Reject unauthorized requests.

------------------------------------------------------------------------

## Step 3: Configure Caddy

### Example Rule

    cachey.example.com {
      reverse_proxy /v1/* localhost:9001
    }

Where `9001` is proxy service port.

------------------------------------------------------------------------

## Step 4: Implement UI Proxy Client

Create: `lib/clickhouse/proxyClient.ts`

Responsibilities: - Send SQL + params to VPS proxy. - Attach API key. -
Handle errors.

------------------------------------------------------------------------

## Step 5: Replace Mock Runner

Update `runClickhouseTriage`:

-   If proxy env vars present:
    -   Use proxy client.
-   Else:
    -   Use mock.

------------------------------------------------------------------------

## Step 6: Verification

Run paired queries:

-   contentType=manifest
-   contentType=segment

Confirm: - totals differ - latency differs - error counts differ

------------------------------------------------------------------------

## Step 7: Production Hardening

-   Add rate limits.
-   Query allowlist.
-   Timeouts.
-   Structured logging.
-   Audit trail.

------------------------------------------------------------------------

## Long-Term Follow-ups

-   Add `dim_partner` lookup table.
-   Auto-sync UI partner list.
-   Add ingestion freshness monitor.
-   Add slow-query detection.
-   Add query cost controls.

------------------------------------------------------------------------

## Status

As of 2026-02-23: - Debug pipeline validated. - SQL generation stable. -
Partner/time issues resolved. - Ready for proxy execution layer.
