# Cachey — Deterministic Incident Triage Engine

**Status:** Phase 6 — Deterministic Swarm + Drill-down Architecture  
**Purpose:** Convert ClickHouse telemetry into a structured, explainable service health assessment.

------------------------------------------------------------------------

## Overview

Cachey is a deterministic incident triage engine built on top of ClickHouse telemetry.

Instead of relying on an LLM to infer system behavior, Cachey:

1. Normalizes user questions into structured scope
2. Executes deterministic ClickHouse queries
3. Builds a shared EvidenceBundle
4. Runs specialized analysis agents (swarm)
5. Applies shared severity rules
6. Combines results into a structured IncidentAssessment
7. Supports follow-up drill-down queries
8. Optionally uses an LLM only for narration

------------------------------------------------------------------------

## Core Philosophy

- Deterministic analysis first  
- SQL = source of truth  
- Shared evidence across agents  
- Drill-down instead of over-fetching  
- LLM is optional and non-authoritative  

------------------------------------------------------------------------

## Investigation Model

### Signals

- traffic  
- latency (p95 + p99)  
- errors  
- cache  

### Dimensions

**Scope Dimensions**
- region  
- pop  
- uaFamily  
- contentType  

**Offender Dimensions**
- host  
- statusCode  
- endpointClass  

### Modes

- Base Diagnosis  
- Drill-down Investigation  

------------------------------------------------------------------------

## Architecture Flow

User  
→ Normalization  
→ Query Layer (ClickHouse)  
→ EvidenceBundle  
→ Agents (traffic / latency / errors / cache / scope)  
→ Severity Rules (shared thresholds)  
→ Assessment Combiner  
→ IncidentAssessment  
→ UI  

------------------------------------------------------------------------

## Query Types

- Base Diagnosis  
- Timeline  
- Peer Comparison  
- Offender Ranking  
- Narrow Scope  

------------------------------------------------------------------------

## EvidenceBundle (Simplified)

- normalizedScope  
- currentMetrics / previousMetrics  
- derivedMetrics (latency, errors, cache, traffic deltas)  
- timeseries  
- breakdowns (region, pop, ua, content)  
- worst offenders  
- sql  
- diagnostics  

------------------------------------------------------------------------

## Agent Layer (Deterministic Swarm)

Each agent evaluates a single signal using shared evidence.

Agents:
- scope → validates + describes scope  
- traffic → evaluates volume and collapse  
- latency → evaluates p95/p99 latency  
- errors → evaluates 5xx behavior  
- cache → evaluates cache efficiency  

Each agent returns:

- state → `normal | elevated | degraded` (UI-facing)  
- severityInternal → internal ranking signal  
- summary → human-readable explanation  
- findings → structured debug context  
- recommendedNextSteps → drill suggestions  

------------------------------------------------------------------------

## Severity Model (Shared)

All signals (except traffic) use centralized rules:

- healthy  
- early_warning  
- performance_issue  
- major_incident  

Severity is computed from:
- thresholds (latency / errors / cache)
- current vs previous comparison

Outputs:
- severity  
- severityReasons  
- severityTopDriver  

------------------------------------------------------------------------

## IncidentAssessment (Final Output)

This is the **single contract consumed by UI**.

### Key fields

- overallState → `normal | elevated | degraded` (**UI primary**)  
- overallStatus → `ok | warn | critical` (internal/compat)  
- severity → internal severity level  
- primarySignal → main driver (cache, latency, errors, traffic, mixed)  
- blastRadius → impacted regions + pops  
- keyFindings → top insights  
- nextActions → suggested drill-downs  
- agents → per-signal breakdown  
- summary → final human-readable explanation  

------------------------------------------------------------------------

## Trust Model

1. Summary (human-readable)
2. Graphs (visual proof)
3. SQL (ground truth)

------------------------------------------------------------------------

## Drill-down System

Follow-up queries trigger targeted investigations:

- worst region  
- worst pop  
- which UA affected  
- manifest vs segment  
- why pop is degraded  
- when did it start  
- isolate dimension (e.g., only mobile)

------------------------------------------------------------------------

## Design Rule

Base query = fast diagnosis  
Follow-up queries = targeted deep dive  

------------------------------------------------------------------------

## Final Mental Model

Signals → traffic / latency / errors / cache  
Dimensions → region / pop / ua / content / host / status  
Reasoning → agents + severity rules + combiner  
Modes → diagnosis / drill-down  
