# Cachey 🤖 – CDN Incident Triage Bot

**Author:** Krishna Reddy GV  
**Production URL:** https://cdn-triage-bot.vercel.app  

---

## Overview

Cachey is a deterministic, warehouse-backed operational analytics system
designed for CDN incident triage.

It transforms structured telemetry into:

-   Deterministic metrics
-   Inspectable SQL
-   Evidence-backed summaries
-   Reproducible triage workflows

Core principle:

> Deterministic metrics first.
> AI assistance second.

All telemetry used in this repository is synthetically generated to
simulate real-world CDN delivery patterns. No production logs are used.

---

## Problem Statement

### Current Operational Challenges

- Manual and time-intensive incident triage
- Reliance on tribal knowledge
- Inconsistent reasoning across engineers
- Lack of reproducibility
- No inspectable intermediate state

### Required Correlations

Effective CDN triage requires correlating:

- Edge vs Upstream Errors  
- Cache Hit / Miss Behavior  
- P95 / P99 Latency Spikes  
- Regional POP Degradation  
- URL Type (Manifest vs Segment)  
- Client / User-Agent Patterns  

### Goal

Systematize first-level triage into deterministic, inspectable, and reproducible workflows.

---

# Architecture Evolution

---

## V1 — Automation Prototype (n8n + Slack)

### Stack

- Slack  
- n8n  
- CSV Telemetry  
- Deterministic Metrics Engine  

### Characteristics

- Slack `/triage` command  
- n8n webhook orchestration  
- One-shot triage execution  
- Summary returned directly to Slack  

### Architecture Diagram

```mermaid
flowchart LR
    A["Slack /triage Command"] --> B["n8n Webhook"]
    B --> C["Parse Filters"]
    C --> D["Fetch CSV Telemetry"]
    D --> E["Deterministic Metrics Engine"]
    E --> F["Slack Summary Response"]
```

### Limitations

- No interactive filtering  
- No persistent state  
- No conversational extensibility  
- Limited transparency into intermediate metrics  

### Conclusion

The automation prototype validated deterministic triage logic,  
but required a standalone UI + API for scalability and state management.

---

## V2 — Deterministic UI + API (Next.js)

### Stack

- Next.js (App Router)  
- React  
- TypeScript  
- Node.js  
- API Routes  

### Objectives

- Externalize system state  
- Ensure reproducibility  
- Enable inspectable intermediate state  
- Prepare for ClickHouse backend  

### Key Features

- Unified `/api/triage` endpoint  
- Explicit filter controls  
- Run history stored in LocalStorage  
- Transparent Metrics JSON  
- Deterministic execution pipeline  

### Architecture Diagram

```mermaid
flowchart TD
    A["User UI"] --> B["Next.js Frontend"]
    B --> C["/api/triage Endpoint"]
    C --> D["Deterministic Metrics Engine"]
    D --> E["Structured Summary"]
    D --> F["Raw Metrics JSON"]
```

### Design Principles

- Deterministic computation  
- Clear request/response boundaries  
- ClickHouse-ready abstraction  
- Separation of computation and explanation  
- Inspectable intermediate state  

---

## V3 — Conversational Controller

### Stack

- Deterministic Intent Parser  
- Optional OpenRouter Integration  

### Objectives

- Introduce conversational triage  
- Preserve deterministic metric computation  
- Allow filter overrides via chat  

### Behavior

- Chat input may override filters  
- Triage execution remains deterministic  
- LLM is not trusted for metric computation  

### Execution Policy

> LLM may assist in intent parsing and explanation generation only.  
> All metrics and decisions are computed deterministically.

### Example Inputs

- `run triage`  
- `svc=live region=use1 win=60`  
- `show p95 spike in bos for vod`  

---

# Current System Architecture

```mermaid
flowchart LR
    A["Browser UI"] --> B["Next.js App Router"]
    B --> C["/api/triage"]
    C --> D["Metrics Engine"]
    D --> E["Structured Summary"]
    D --> F["Raw Metrics JSON"]

    subgraph "Data Layer"
        G["CSV Telemetry (Synthetic)"]
        H["ClickHouse (Planned)"]
    end

    C --> G
    C -. "future integration" .-> H
```

---

## V4 --- Warehouse-Backed Analytics (Current)

### Objective

Replace demo-scale CSV computation with a production-style warehouse
architecture using ClickHouse.

### Data Flow

``` mermaid
flowchart LR
    Generator --> RawEvents
    RawEvents --> ClickHouse
    ClickHouse --> Rollup5m
    Rollup5m --> CacheyAPI
    CacheyAPI --> UI
```


------------------------------------------------------------------------

# Data Architecture

## 1. Raw Events Table

One row per synthetic request.

Example fields:

-   timestamp
-   service (live/vod)
-   region
-   pop
-   partner
-   response_code
-   cache_result
-   ttms
-   ua_family
-   url_type

Used for:

-   Evidence drill-down
-   Modeling
-   Feature engineering
-   Future anomaly detection

------------------------------------------------------------------------

## 2. Rollup Table (5m cadence)

Aggregated by:

-   time bucket
-   service
-   region
-   pop
-   partner

Pre-computed metrics:

-   request_count
-   error_rate
-   p95_ttms
-   p99_ttms
-   cache_hit_ratio

Used for:

-   Fast triage
-   Graph rendering
-   Chat-based queries

------------------------------------------------------------------------

# Current System Architecture

``` mermaid
flowchart TD
    subgraph Frontend
        ChatUI
        FilterPanel
        TriageCards
    end

    subgraph API Layer
        ChatAPI
        TriageAPI
    end

    subgraph Data Layer
        ClickHouse
        RawEvents
        Rollup5m
    end

    ChatUI --> ChatAPI
    FilterPanel --> TriageAPI
    ChatAPI --> TriageAPI
    TriageAPI --> ClickHouse
    ClickHouse --> Rollup5m
    ClickHouse --> RawEvents
    TriageAPI --> TriageCards
```

------------------------------------------------------------------------

# Conversational Execution Model

When user types:

    live in bos last 2h

System:

1.  Deterministically parses filters
2.  Constructs SQL
3.  Queries rollup table
4.  Returns:
    -   Summary
    -   Metrics JSON
    -   Graph data
    -   Expandable SQL
    -   Expandable Evidence

LLM (optional):

-   May refine intent
-   May assist explanation
-   Never computes metrics


# Technology Stack

## Frontend

- Framework: Next.js (App Router)  
- Language: TypeScript  
- UI Library: React  
- State Management: LocalStorage (Run History)  
- Rendering Strategy: Hydration-safe client rendering  

## Backend

- API Layer: Next.js API Routes  
- Runtime: Node.js  
- Analytics Layer: Custom Deterministic Metrics Engine  

## Data Layer

-   Synthetic event generator
-   ClickHouse
-   Raw + Rollup tables
-   SQL as source of truth

## Conversational Layer

-   Deterministic parser
-   Optional OpenRouter integration
-   Free-tier model fallback handling
-   Rate-limit resilience

## Deployment

-   Hosted on Vercel
-   Automatic builds from GitHub
-   Production + Preview environments
-   TypeScript validation on build

### Example Models

- `google/gemma-3n-e2b-it:free`  
- `mistral-small-instruct`  

### LLM Scope

- Intent parsing  
- Explanation assistance  
- No non-deterministic metric computation  

---

# Deployment

## Hosting

- Vercel  
- Automatic builds from GitHub  
- Production + Preview environments  
- Build-time TypeScript validation  


## Migration Reason

- Stable hosting  
- Reliable demo access  
- CI/CD integration  

---

# Data Safety

- All telemetry is synthetic
- No production logs are included
- No customer data is used
- No proprietary systems are exposed


---

# Engineering Philosophy

- Deterministic metrics before AI reasoning  
- Reproducibility over opacity  
- Separation of control and computation  
- Explainable summaries  
- Production-first deployment validation  

---

# Roadmap

## Short-Term

-   SQL editor panel
-   Evidence sampling from raw table
-   Materialized views
-   Query transparency improvements

## Mid-Term

-   Time-series anomaly detection
-   Rolling baseline deviation scoring
-   Blast radius estimation
-   Confidence scoring

## Long-Term (MLOps Track)

-   Feature store integration
-   Model lifecycle orchestration
-   Automated retraining hooks
-   Severity classification models