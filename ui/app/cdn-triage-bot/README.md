# CDN Incident Triage Bot  
**V1 (n8n + Slack) → V2 (Standalone UI + API)**

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
