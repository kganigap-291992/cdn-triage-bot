# CDN Incident Triage Bot  
**V1 (n8n + Slack) → V2 (Standalone UI + API)**
**Author & Maintainer:** Krishna Reddy  

An automated CDN incident triage system that analyzes delivery telemetry
(edge, mid-tier, cache, URL patterns, and client signals) and produces
**evidence-backed diagnosis and drill-down insights**.

This project mirrors real-world CDN/video operations and demonstrates
how operational analytics, automation, and tooling evolution can be
applied safely in production-style workflows.

---

## Data Safety

All telemetry used in this project is **synthetically generated** to mirror
real-world CDN traffic patterns.

- No production logs
- No customer data
- No proprietary systems

---

## Why This Project Exists

CDN incident triage is often:

- manual and time-consuming  
- dependent on tribal knowledge  
- difficult to standardize across teams  

Engineers must correlate:
- edge vs upstream errors  
- cache behavior  
- latency spikes  
- URL types (manifest vs segment)  
- regional POP failures  
- client / User-Agent patterns  

**This project automates first-level triage** using deterministic rules,
clear metrics, and explainable summaries.

---

# V1 — n8n + Slack (Prototype Phase)

V1 focused on **speed of iteration and signal validation**.

### Why a UI Was Required (Beyond Automation)

While n8n worked well for automated, one-shot triage, it is not designed
for interactive or conversational workflows.

Chat-based triage requires:
- deterministic and reproducible metrics
- explicit request/response boundaries
- inspectable intermediate state
- clear separation between computation and explanation

The move to a UI + API architecture in V2 was a prerequisite for any
future chat or agent-based interface. The UI externalizes system state
and makes reasoning observable, allowing conversational layers to sit
on top without compromising correctness.


## V1 High-Level Architecture

```mermaid
flowchart LR
    A[Slack<br/>/triage command] -->|HTTP POST| B[n8n Webhook]
    B --> C[Parser<br/>Parse filters & window]
    C --> D[HTTP Request<br/>Fetch CSV]
    D --> E[Metrics Engine<br/>Errors & P95 TTMS]
    E --> F[Slack<br/>Summary Response]
```

### Why a UI Was Required (Beyond Automation)

While n8n worked well for automated, one-shot triage, it is not designed
for interactive or conversational workflows.

Chat-based triage requires:
- deterministic and reproducible metrics
- explicit request/response boundaries
- inspectable intermediate state
- clear separation between computation and explanation

The move to a UI + API architecture in V2 was a prerequisite for any
future chat or agent-based interface. The UI externalizes system state
and makes reasoning observable, allowing conversational layers to sit
on top without compromising correctness.


## Demo UI (Deterministic) — Triage + Chat Controller

This demo UI provides:
- CSV URL or CSV file upload
- Filter controls: service, region, pop, window (minutes)
- Run History (last 10) stored in localStorage
- Metrics summary + raw metricsJson
- **Chat panel (Phase B1)**: chat-shaped controller that runs the same deterministic triage using the current filters

### Architecture

- The application is a single Next.js web UI.
- Users can run triage either via filters or via chat.
- Chat is currently deterministic and acts as a controller.
- All requests flow through a single `/api/triage` endpoint.
- CSV logs are used for demos; ClickHouse will replace CSV in future versions without changing the UI.


### Chat behavior (Phase B1)
Chat is not an LLM yet. It is a control surface:
- User types a message
- We optionally parse simple overrides from text:
  - `service=vod` / `svc=vod`
  - `region=use1`
  - `pop=sjc`
  - `win=60` / `window=60`
- Then the UI runs `/api/triage` deterministically and prints the summary

### Example chat inputs
- `run triage`
- `service=vod region=usw2 pop=sjc win=60`
- `svc=live win=15`

### Why deterministic first?
We intentionally keep metrics computation deterministic for:
- reproducibility
- debugging
- future ClickHouse swap without changing the UI

### ClickHouse (Mock Mode)

The ClickHouse data path is wired end-to-end (UI → API → metrics → charts)
using **simulated data**.

This validates:
- schema assumptions
- API contracts
- metrics shape
- UI and chat behavior

No ClickHouse credentials are required to run or demo the system.

The mock runner will be replaced with real 
ClickHouse execution **without any UI or API changes**.


