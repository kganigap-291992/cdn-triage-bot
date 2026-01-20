# CDN Incident Triage Bot (n8n + Slack)

An automated incident triage system that analyzes CDN telemetry
(edge, mid-tier, cache, URL patterns, and client signals) and produces
evidence-backed diagnosis and drill-down insights via Slack.

This project mirrors CDN/video operations and demonstrates
how operational analytics, automation, and (optionally) LLMs can be
safely integrated into production workflows.

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


