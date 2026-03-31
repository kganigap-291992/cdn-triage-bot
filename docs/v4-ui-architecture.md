# Cachey UI — Canonical Spec (v1)

## Purpose
This is the **full, no-loss system design** for Cachey UI.
It captures routing, state, UI, agents interaction, and UX rules.

---

# 1. System Overview

Cachey is a **deterministic CDN triage engine with a conversational UI**.

Flow:

User → Router → Query Plan → ClickHouse → EvidenceBundle → Agents → IncidentAssessment → UI

---

# 2. Routing Brain (Full Logic)

## Intent Classification Tree

1. Empty / greeting → greeting
2. Contains CDN/ATS concept → glossary / knowledge
3. Missing scope but operational → clarification
4. Valid operational query → triage
5. Follow-up keywords:
   - worst / top → drill
   - compare / previous → compare
   - only / filter → filter
   - why / explain → explain
6. Non-CDN → guardrail

---

## Routing Matrix

| Intent | Uses Scope | Mutates Scope | Calls API |
|--------|-----------|--------------|----------|
| triage | yes       | yes          | yes      |
| drill  | yes       | sometimes    | yes      |
| compare| yes       | no           | yes      |
| filter | yes       | yes          | yes      |
| explain| yes       | no           | no       |
| glossary| no       | no           | no       |
| knowledge| no      | no           | LLM      |
| greeting| no       | no           | no       |
| guardrail| no      | no           | no       |

---

# 3. State Model (Strict)

## Global State

activeScope  
missionContext  
conversationHistory  
lastResult  
pendingFilters  
executionState  

---

## Scope Mutation Table

| Action        | Mutates Scope |
|---------------|--------------|
| triage        | yes          |
| drill region  | yes          |
| drill pop     | yes          |
| filter apply  | yes          |
| compare       | no           |
| explain       | no           |
| glossary      | no           |

---

# 4. Mission Context Rules

Update ONLY on:
- triage
- drill (if narrowing)
- filter

Never update on:
- explain
- compare
- glossary
- greeting

---

# 5. UI Architecture

## Layout

Mission Strip  
Conversation Thread  
Chat Input  

---

# 6. Card Contracts

## Triage Card

Inputs:
- IncidentAssessment

Outputs:
- summary
- state
- primary signal
- findings
- next actions
- graph
- proof

---

## Drill Card

Inputs:
- breakdown data

Outputs:
- ranked list
- summary
- next actions

---

## Compare Card

Inputs:
- current vs previous

Outputs:
- delta summary
- graph

---

## Explain Card

Inputs:
- EvidenceBundle

Outputs:
- explanation text

---

# 7. Graph System

Primary:
- 1 graph only

Proof:
- secondary graphs

Follow-ups:
- max 1 graph

---

# 8. Evidence System

EvidenceBundle includes:

- metrics
- breakdowns
- timeseries
- SQL
- diagnostics

---

# 9. UX Rules

Tone:
- calm
- precise
- operational

---

## Microcopy Examples

Loading:
Investigating service health...

Error:
Could not complete request. Try adjusting scope.

No Data:
No data found. Try widening window.

---

# 10. Filters Model

pendingFilters ≠ activeScope

Apply → mutate scope  
Clear → reset draft  

---

# 11. Reset Rules

Reset clears:
- scope
- mission
- history (v1)

---

# 12. Implementation Map

page.tsx → shell  
ChatInput → input + filters  
Thread → history  
MissionStrip → context  
Cards → rendering  
Router → classification  

---

# 13. Future Extensions

## Redis
- persist conversation
- persist scope

## LLM
- narration only
- never source of truth

## Multi-layer Agents
- edge + mid + origin
- combine assessments

---

# 14. Final Mental Model

Cachey = Deterministic Engine + Chat Interface

NOT a chatbot.

---

End.
