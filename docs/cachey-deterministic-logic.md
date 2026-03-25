# Cachey --- Deterministic Incident Triage Engine

**Status:** Phase 6 --- Deterministic Swarm + Drill-down Architecture\
**Purpose:** Convert ClickHouse telemetry into a structured, explainable
service health assessment.

------------------------------------------------------------------------

## Overview

Cachey is a deterministic incident triage engine built on top of
ClickHouse telemetry.

Instead of relying on an LLM to infer system behavior, Cachey:

1.  Normalizes user questions into structured scope
2.  Executes deterministic ClickHouse queries
3.  Builds a shared EvidenceBundle
4.  Runs specialized analysis agents (swarm)
5.  Produces a structured IncidentAssessment
6.  Supports follow-up drill-down queries
7.  Optionally uses an LLM only for narration

------------------------------------------------------------------------

## Core Philosophy

-   Deterministic analysis first
-   SQL = source of truth
-   Shared evidence across agents
-   Drill-down instead of over-fetching
-   LLM is optional and non-authoritative

------------------------------------------------------------------------

## Investigation Model

### Signals

-   traffic
-   latency (p95 + p99)
-   errors
-   cache

### Dimensions

**Scope Dimensions** - region - pop - uaFamily - contentType

**Offender Dimensions** - host - statusCode - endpointClass

### Modes

-   Base Diagnosis
-   Drill-down Investigation

------------------------------------------------------------------------

## Architecture Flow

User → Normalization → Query Layer → EvidenceBundle → Agents →
IncidentAssessment → UI

------------------------------------------------------------------------

## Query Types

-   Base Diagnosis
-   Timeline
-   Peer Comparison
-   Offender Ranking
-   Narrow Scope

------------------------------------------------------------------------

## EvidenceBundle (Simplified)

-   normalizedScope
-   currentMetrics / previousMetrics
-   derivedMetrics (p95, p99, errors, cache)
-   breakdowns (region, pop, ua, content)
-   worst offenders
-   sql
-   diagnostics

------------------------------------------------------------------------

## Latency Design

-   p95 → general experience
-   p99 → tail / hotspot issues

------------------------------------------------------------------------

## IncidentAssessment

-   overallStatus
-   primarySignal
-   blastRadius
-   keyFindings
-   agents
-   summary

------------------------------------------------------------------------

## Trust Model

1.  Summary
2.  Graphs
3.  SQL Evidence

------------------------------------------------------------------------

## Drill-down System

Follow-up queries trigger targeted investigations:

-   worst region
-   worst pop
-   which UA affected
-   manifest vs segment
-   why pop bad
-   when did it start
-   only mobile

------------------------------------------------------------------------

## Design Rule

Base query = fast diagnosis\
Follow-up queries = targeted deep dive

------------------------------------------------------------------------

## Roadmap

-   Phase 5: UI stabilization ✅
-   Phase 6: Swarm + drill-down (current)
-   Phase 7: LLM narration

------------------------------------------------------------------------

## Final Mental Model

Signals → traffic / latency / errors / cache\
Dimensions → region / pop / ua / content / host / status\
Modes → diagnosis / drill-down
