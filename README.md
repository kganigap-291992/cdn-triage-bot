# CDN Incident Triage Bot (n8n + Slack)

An automated incident triage system that analyzes CDN telemetry
(edge, mid-tier, cache, URL patterns, and client signals) and produces
evidence-backed diagnosis and drill-down insights via Slack.

This project mirrors CDN/video operations and demonstrates
how operational analytics, automation, and (optionally) LLMs can be
safely integrated into production workflows.

---

## Data Safety

All telemetry used in this project is **synthetically generated** to mirror real-world CDN traffic patterns.
No production logs, customer data, or proprietary systems are involved.

---

## Why this project exists

CDN incident triage is often:
- manual and time-consuming
- dependent on tribal knowledge
- difficult to standardize across teams

Engineers must correlate:
- edge vs upstream errors
- cache behavior
- latency spikes
- URL types (manifest vs segment)
- regional edge issues
- client/User-Agent patterns

**This project automates first-level triage** using deterministic rules,
clear metrics, and human-in-the-loop Slack workflows.

---

## High-level architecture

Slack Slash Command (/triage)
 →
n8n Workflow Orchestrator
 →
Log Ingestion (CSV → pluggable DB source)
 →
Feature Derivation & Aggregation
 →
Rule-based Diagnosis & Drilldowns
 →
Slack Summary + Interactive Queries


**Key design principle:**  
The ingestion layer is fully replaceable. CSV-based logs are used for demo
purposes and can be swapped with a production telemetry database
(e.g. ELK / MapleDB / ClickHouse) without changing triage logic.

---
## Dataset

For demo purposes, the project uses a **single 10,000-row CSV**
representing 60 minutes of CDN traffic.

Multiple real-world failure patterns are embedded implicitly via:
- time windows
- regions/POPs
- delivery service
- URL/asset behavior

  
### Derived features (inside the workflow)
- `region`, `pop` from edge cache naming
- `asset_id`, `asset_type` (manifest vs segment) from URL
- cache hit ratio
- latency percentiles (p50/p95/p99)
- upstream byte amplification
- error concentration by asset, cache, region, UA

---

## Supported Slack queries

The bot is driven entirely via Slack slash commands.

## Running the demo

1. Create a Slack app with a `/triage` slash command
2. Deploy the n8n workflow
3. Host the CSV via GitHub raw URL
4. Run `/triage` commands from Slack

---

## High-Level n8n Flow

```mermaid
flowchart LR
    A[Slack<br/>/triage command] -->|HTTP POST| B[n8n Webhook]
    B --> C[Parser<br/>Parse filters & window]
    C --> D[HTTP Request<br/>Fetch CSV]
    D --> E[Metrics Engine<br/>Errors & P95 TTMS]
    E --> F[Slack<br/>Summary Response]


