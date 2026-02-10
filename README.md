# CDN Incident Triage Bot

**Author & Maintainer:** Krishna Reddy GV

**Evolution:**  
V1 (n8n + Slack) → V2 (Standalone UI + Deterministic API) →  
V3 (Stateful Conversational Chat)

An automated CDN incident triage system that analyzes delivery telemetry
(edge, mid-tier, cache, URL patterns, latency, and error signals) and produces
deterministic, evidence-backed diagnostics with progressive conversational
capabilities.

This project mirrors real-world CDN/video operations and demonstrates how
automation, analytics, and LLMs can be layered safely on top of
production-style systems.

---

## Data Safety

All telemetry used in this project is synthetically generated.

- No production logs
- No customer data
- No proprietary systems

---

## Why This Project Exists

CDN incident triage is often:

- Manual and time-consuming
- Dependent on tribal knowledge
- Hard to standardize across teams

Engineers must correlate:

- Edge vs upstream errors
- Cache behavior and CRC patterns
- Latency spikes (p95 / p99 TTMS)
- URL types (manifest vs segment)
- Region and POP-level failures

This project automates first-level triage using deterministic metrics,
clear summaries, and explainable drill-downs.

---

## V1 — n8n + Slack (Prototype Phase)

### Goal
Validate signals, metrics, and summaries with minimal UI and fast iteration.

### Characteristics
- Slack-triggered triage commands
- Stateless, one-shot execution
- CSV-based telemetry ingestion
- Deterministic metrics and summaries

### V1 Architecture

Slack /triage command
↓
n8n Webhook
↓
Filter Parser (service, region, window)
↓
CSV Fetch
↓
Metrics Engine

error counts

error rate

p95 TTMS
↓
Slack Summary Response


### Limitations
- No interactivity or follow-ups
- No state between runs
- Not suitable for conversational workflows

---

## V2 — Standalone UI + Deterministic API

### Why V2 Was Necessary

Chat-based triage requires:

- Explicit request/response boundaries
- Inspectable intermediate state
- Deterministic and reproducible outputs
- Separation of computation from explanation

n8n is not designed for interactive or conversational workflows.

### What V2 Introduced

- Standalone Next.js UI
- Dedicated triage API
- Deterministic metrics engine
- Charts, drill-downs, and run history
- CSV and ClickHouse (mock) data sources

### V2 Architecture

User (Browser)
↓
UI Filters + Run Action
↓
Triage API
↓
Metrics Engine

bucketed aggregations

latency and error metrics
↓
Metrics JSON
↓
Charts + Summary


### Core Principle

All computation is deterministic.  
The UI externalizes system state so reasoning is observable and debuggable.

---

## V3 — Stateful Conversational Chat (Current)

### Goal
Enable natural, multi-turn triage without compromising correctness.

The LLM assists with parsing and conversation only — never computation.

### What V3 Adds

- Conversational assistant (Cachey)
- Dedicated `/api/chat` endpoint
- Server-side session memory (cookie-based). TTL to expire in 6hrs
- Multi-turn filter refinement
- ClickHouse partner-aware workflows
- Follow-up shortcuts (`same`, `again`, `last 2h`, `live`, `vod`)
- Graceful fallback when LLMs fail

### V3 Architecture

User Message
↓
Intent Detection
↓
├─ General Chat (LLM)
│
└─ Triage Parsing (LLM → JSON)
↓
Server-side Memory
↓
Deterministic Metrics Engine
↓
CSV / ClickHouse
↓
Charts + Summary Output

### Design Guarantees

- Deterministic metrics always win
- Memory stores filters, not results
- Partner selection is explicit and validated
- Chat failures never block triage execution

---

## LLM Usage Philosophy

- LLMs do not compute metrics
- LLMs do not mutate infrastructure
- LLMs assist with:
  - intent detection
  - filter extraction
  - conversational UX
- All outputs are validated and normalized