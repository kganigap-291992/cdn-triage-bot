# UI Service Architecture (End-to-End)

This document explains how the UI service works from request →
middleware → API → ClickHouse → response.

------------------------------------------------------------------------

## Overview

The UI service is a Next.js application that:

-   Serves authenticated UI pages
-   Exposes public `/api/*` routes
-   Orchestrates ClickHouse triage (mock / proxy / real DB)

Core rule:

> `/api/*` is always public. UI pages are gated by cookie.

------------------------------------------------------------------------

## Architecture Diagram

``` mermaid
flowchart LR

U[Browser] --> MW[middleware]
C[curl] --> MW

MW -->|/api/*| API
MW -->|static| STATIC
MW -->|auth| UI

UI --> PAGES
UI --> DEMO

API --> TRIAGE
API --> SCHEMA

TRIAGE --> ORCH
ORCH --> SQL
ORCH --> RUN

RUN --> MOCK
RUN --> PROXY
PROXY --> CLICKHOUSE

MOCK --> RESP
CLICKHOUSE --> RESP

RESP --> API
API --> U
API --> C
```

------------------------------------------------------------------------

## Request Flow

### UI Page

1.  Request hits middleware
2.  Cookie `cachey_demo` checked
3.  If missing → /demo
4.  If present → page loads

### API

1.  Hits middleware
2.  `/api/*` bypasses auth
3.  Route executes
4.  Returns JSON

------------------------------------------------------------------------

## middleware.ts

Controls access.

Rules:

  Path         Behavior
  ------------ ----------------
  /api/\*      Always allowed
  /\_next/\*   Allowed
  /demo        Allowed
  Static       Allowed
  Others       Need cookie

Cookie:

    cachey_demo=1

------------------------------------------------------------------------

## api/triage/route.ts

Main data entrypoint.

Responsibilities:

-   Parse inputs
-   Normalize fields
-   Call ClickHouse runner
-   Return unified JSON

Example:

``` json
{
  "partner": "acme_media",
  "service": "all",
  "region": "all",
  "pop": "all",
  "windowMinutes": 60,
  "debug": true,
  "contentType": "all",
  "uaFamily": "all"
}
```

Returns:

``` json
{
  "summary": "...",
  "metricsJson": {},
  "sql": {}
}
```

------------------------------------------------------------------------

## api/schema/route.ts

Provides metadata for UI dropdowns.

Used for validation.

------------------------------------------------------------------------

## runClickhouseTriage.ts

Central orchestrator.

Steps:

1.  Map partner
2.  Build SQL
3.  Select runner
4.  Normalize output

Never builds SQL manually.

------------------------------------------------------------------------

## runMockClickhouseTriage.ts

Generates deterministic fake data.

Used for:

-   Local dev
-   Demos
-   Testing UI

Features:

-   Time series
-   Anomalies
-   Debug forcing
-   Stable seeds

------------------------------------------------------------------------

## runProxyClickhouseTriage.ts (Future)

Will:

-   Send SQL to VPS
-   Talk to Cachey Proxy
-   Execute real ClickHouse queries

Flow:

UI → API → Proxy → ClickHouse

------------------------------------------------------------------------

## SQL Builder

All SQL originates from:

    lib/clickhouse/sqlBuilder.ts

Guarantees:

-   Canonical queries
-   Filter safety
-   Stable structure

------------------------------------------------------------------------

## Debug Mode

If debug=true:

-   Forces anomalies
-   Adds metadata
-   Anchors SQL
-   Adds warnings

Used for UI testing.

------------------------------------------------------------------------

## Design Principles

1.  Single source of truth (sqlBuilder)
2.  Public APIs
3.  Stable response shape
4.  Mock-first development
5.  Proxy-ready architecture

------------------------------------------------------------------------

## File Responsibilities

  File            Role
  --------------- --------------
  middleware.ts   Auth gate
  api/triage      Main API
  api/schema      Metadata
  runClickhouse   Orchestrator
  runMock         Fake DB
  runProxy        Real DB
  sqlBuilder      SQL factory

------------------------------------------------------------------------

## Production Flow (Future)

    Browser
      ↓
    API
      ↓
    Proxy (VPS)
      ↓
    ClickHouse
      ↓
    Metrics

------------------------------------------------------------------------

## Development Flow (Today)

    Browser
      ↓
    API
      ↓
    Mock Runner
      ↓
    Synthetic Metrics

------------------------------------------------------------------------

## Why CSV Was Removed

CSV path was legacy debug.

Problems:

-   Inconsistent
-   Hard to validate
-   Different shape

Now:

✔ ClickHouse-first ✔ Mock replaces CSV ✔ Unified pipeline

------------------------------------------------------------------------

## Summary

This UI service is:

-   A secure frontend
-   A thin API layer
-   A ClickHouse orchestrator

It is designed to:

-   Scale to real DB
-   Support demos
-   Avoid breaking curl
-   Keep UI stable

------------------------------------------------------------------------

End of document.
