# Cachey — Intent Parsing & Normalization Design

## Overview
This document defines the deterministic intent parsing and normalization layer for Cachey.

Goal:
- Accept natural chat input
- Convert to structured triage queries
- Keep backend contract strict and unchanged

This layer runs BEFORE `/api/triage`.

---

## High-Level Flow
User Input
→ Intent Parser
→ Normalizer
→ Scope Resolution
→ API Call (/api/triage)

---

## Core Design Principles

### 1. Canonical API Contract (STRICT)
Only canonical values are allowed beyond parsing.

Examples:
- partner_01
- live
- us-east
- pop_003

Aliases must never reach:
- API
- Proxy (Caddy)
- ClickHouse

---

### 2. Alias Handling at UI Edge Only
Aliases are accepted only in:
- Chat input
- UI parsing layer

They are resolved before API execution.

---

### 3. Schema-Driven Normalization
All aliases are defined centrally in:

lib/schema/canonical.ts

No alias logic in:
- UI components
- API routes
- runners

---

### 4. Deterministic Parsing (No LLM)
Intent detection is rule-based.

No LLM used for:
- trigger detection
- scope extraction
- normalization

---

### 5. Separation of Concerns

canonical.ts → vocab + alias metadata  
normalize.ts → alias → canonical resolution  
intent.ts → intent detection + parsing  
page.tsx → UI + prompting + execution  
route.ts → validation + triage execution  

---

## Schema Design

### Canonical Values (UNCHANGED)

CANON = {
  partners: ["partner_01", "partner_02", "partner_03"],
  services: ["live", "vod", "dvr", "eas", "live_ott", "app_backend"],
  regions: ["us-east", "us-west", "eu-west"],
  pops: ["pop_001", "pop_002", "pop_003"]
}

These remain unchanged for compatibility.

---

### Metadata (NEW — Parallel)

Each entry contains:
- value (canonical)
- label (display)
- aliases (safe inputs)

---

## Service Aliases (Phase 1)

live:
- live
- linear
- live tv
- live-tv

vod:
- vod
- on demand
- ondemand

dvr:
- dvr
- cdvr
- recording
- recordings

eas:
- eas

live_ott:
- tve
- ott

app_backend:
- app_backend

---

## Alias Policy

Allowed:
- explicit
- low ambiguity
- domain-safe

Not allowed:
- streaming
- app
- tv
- video
- generic terms

---

## Normalization Rules

Before matching:
- lowercase input
- replace '_' with space
- trim whitespace
- collapse multiple spaces

Examples:
- Live_TV → live tv
- OnDemand → ondemand

---

## Intent Detection

### MUST TRIGGER
Examples:
- how was live last night
- check errors
- investigate vod latency
- partner 1 live

Signals:
- investigation verbs
- health-check phrasing
- metric keywords
- time + scope

---

### CONDITIONAL TRIGGER
Requires prior context:
- what about vod
- check it again
- only us-east
- compare with previous

---

### NEVER TRIGGER
Examples:
- hi
- thanks
- hello live team
- partner 1 meeting

---

## Scope Extraction

Parser extracts:
- partner
- service
- region (optional)
- pop (optional)
- metric hint
- time hint

---

## Missing Scope Handling

If intent is valid but incomplete:

Missing service → ask for service  
Missing partner → ask for partner  
Missing both → ask for service first  

---

### Sticky Behavior

If value exists in UI state:
- use silently
- do not prompt

---

## Example Behavior

Input: how was live last night  
→ service=live  
→ partner missing  
→ prompt for partner  

Input: check partner 1  
→ partner=partner_01  
→ service missing  
→ prompt for service  

Input: live in partner 1  
→ run triage  

Input: hello live team  
→ do not trigger  

---

## Follow-Up Handling

Requires prior context:
- check it again
- what about vod
- only us-east

Without context → reject or prompt

---

## Non-Goals 

- No LLM parsing
- No fuzzy matching
- No probabilistic scoring
- No backend contract changes

---

# 🕒 Named Time Resolution 

This document defines the deterministic mapping of human time phrases
(e.g., "last night", "this morning") into executable query windows.

These mappings are **frozen for v1** and must remain stable unless explicitly versioned.

---

## 🔒 Core Policies

### Policy 1 — Timezone

- All human phrases are interpreted in:
  → `America/New_York`

- All queries execute in:
  → UTC

- Resolver must output:
  - Local time window (for readability)
  - UTC time window (for execution)

---

### Policy 2 — Future Windows

- The system must NOT silently resolve future time ranges.

Example:
- `"tonight"` before 18:00 local time → ❌ invalid

Instead, return:

"Tonight has not started yet in America/New_York."

---

## 🧠 Named Time Mappings (v1)

All intervals are **half-open**:
[start, end)

---

### 1. last night
- Previous day 20:00 → Current day 06:00

---

### 2. overnight
- Previous day 22:00 → Current day 06:00

---

### 3. today
- Today 00:00 → Now

---

### 4. this morning
- Today 06:00 → min(Now, 12:00)

---

### 5. this afternoon
- Today 12:00 → min(Now, 18:00)

---

### 6. tonight

- If current time < 18:00:
  → ❌ Not started

- If current time ≥ 18:00:
  → Today 18:00 → Now

---

### 7. yesterday
- Previous day 00:00 → Current day 00:00

---

### 8. yesterday evening
- Previous day 18:00 → Current day 00:00

---

### 9. now / right now
- Last 30 minutes

---

## 🧩 Resolver Contract

The resolver must return a structured result.

### Success

```ts
type ResolvedTimeWindow = {
  key: string;
  label: string;
  timezone: "America/New_York";

  startLocalIso: string;
  endLocalIso: string;

  startUtcIso: string;
  endUtcIso: string;

  timeMode: "absolute";
  source: "named_time";
};
---

## Summary

This system:
- Accepts natural input
- Resolves aliases safely
- Maintains strict API contracts
- Improves UX without infra changes

This forms the foundation for future LLM enhancements.


# 🔁 Multi-Hop Investigation (Phase 5C)

This section defines how Cachey supports **follow-up / conversational triage workflows**.

Goal:
- Allow users to iteratively investigate issues using chat
- Reuse prior triage results as context
- Keep execution deterministic and reproducible

---

## 🧠 Design Principles

### 1. Latest-Run Driven (No Persistence)

All follow-up behavior is derived from:
- the **most recent triage run**
- its scope
- its evidence (metricsJson / swarm output)

No Redis or persistent memory is used in v1.

---

### 2. Deterministic Follow-Up Resolution

Follow-up queries must resolve into either:
- **Answer-only response** (no rerun), or
- **Derived triage inputs** → executed via `/api/triage`

No implicit or hidden state mutations.

---

### 3. No Backend Contract Changes

All follow-up reruns must produce standard inputs:

```ts
{
  partner,
  service,
  region,
  pop,
  contentType,
  uaFamily,
  windowMinutes | absolute time
}
