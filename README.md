# Cachey 🤖 – CDN Incident Triage Bot

**Automated Operational Analytics for CDN Incident Response**

Author: Krishna Reddy GV  
Production Deployment: https://cdn-triage-bot.vercel.app  

---

> This document describes the system architecture, evolution, and deployment
> model of Cachey 🤖 in structured specification format.

---

## System Architecture Specification



Project:
  Name: "Cachey 🤖 – CDN Incident Triage Bot"
  Author: "Krishna Reddy GV"
  ProductionURL: "https://cdn-triage-bot.vercel.app"
  Summary: >
    Automated operational analytics system for CDN incident triage.
    Analyzes structured delivery telemetry and produces deterministic,
    evidence-backed summaries suitable for incident response workflows.

ProblemStatement:
  Context:
    - Manual and time-intensive incident triage
    - Reliance on tribal knowledge
    - Inconsistent reasoning across engineers
    - Lack of reproducibility
  RequiredCorrelations:
    - Edge vs Upstream Errors
    - Cache Hit/Miss Behavior
    - P95 / P99 Latency Spikes
    - Regional POP Degradation
    - URL Type (Manifest vs Segment)
    - Client / User-Agent Patterns
  Goal: >
    Systematize first-level triage into deterministic,
    inspectable, and reproducible workflows.

ArchitectureEvolution:

  V1:
    Name: "Automation Prototype (n8n + Slack)"
    Stack:
      - Slack
      - n8n
      - CSV Telemetry
      - Deterministic Metrics Engine
    Characteristics:
      - Slack /triage Command
      - n8n Webhook Orchestration
      - One-Shot Triage Execution
      - Summary Returned to Slack
    ArchitectureDiagram: |
      flowchart LR
          A[Slack /triage] --> B[n8n Webhook]
          B --> C[Parse Filters]
          C --> D[Fetch CSV Telemetry]
          D --> E[Metrics Engine]
          E --> F[Slack Summary Response]
    Limitations:
      - No Interactive Filtering
      - No Persistent State
      - No Conversational Extensibility
    Conclusion: "Standalone UI + API Required"

  V2:
    Name: "Deterministic UI + API (Next.js)"
    Stack:
      - Next.js (App Router)
      - React
      - TypeScript
      - Node.js
      - API Routes
    Objectives:
      - Externalize System State
      - Ensure Reproducibility
      - Enable Inspectable Intermediate State
    KeyFeatures:
      - Unified /api/triage Endpoint
      - Explicit Filter Controls
      - Run History Stored in LocalStorage
      - Transparent Metrics JSON
    ArchitectureDiagram: |
      flowchart TD
          A[User UI] --> B[Next.js Frontend]
          B --> C[/api/triage Endpoint]
          C --> D[Deterministic Metrics Engine]
          D --> E[Summary + Metrics JSON]
    DesignPrinciples:
      - Deterministic Computation
      - Clear Request/Response Boundaries
      - ClickHouse-Ready Abstraction
      - Separation of Computation and Explanation

  V3:
    Name: "Conversational Controller"
    Stack:
      - Deterministic Parser
      - OpenRouter Integration (Optional)
    Objectives:
      - Introduce Conversational Triage
      - Preserve Deterministic Computation
    Behavior:
      - Chat Input May Override Filters
      - Deterministic Triage Execution
      - Summary Rendered Conversationally
    ExampleInputs:
      - "run triage"
      - "svc=live region=use1 win=60"
    LLMPolicy: >
      LLM usage is restricted to parsing and explanation assistance.
      Metric computation remains deterministic.

CurrentSystemArchitecture:
  Diagram: |
    flowchart LR
        A[Browser UI] --> B[Next.js App Router]
        B --> C[/api/triage]
        C --> D[Metrics Engine]
        D --> E[Structured Summary]
        D --> F[Raw Metrics JSON]

        subgraph Data Layer
            G[CSV Telemetry]
            H[ClickHouse (Planned)]
        end

        C --> G
        C -. future .-> H

TechnologyStack:

  Frontend:
    Framework: "Next.js (App Router)"
    Language: "TypeScript"
    UILibrary: "React"
    StateManagement: "LocalStorage (Run History)"
    RenderingStrategy: "Hydration-Safe Client Rendering"

  Backend:
    APILayer: "Next.js API Routes"
    Runtime: "Node.js"
    AnalyticsLayer: "Custom Deterministic Metrics Engine"

  DataLayer:
    DemoSource: "Synthetic CSV Telemetry"
    ProductionTarget: "ClickHouse (Planned)"

  ConversationalLayer:
    CurrentMode: "Deterministic Parser"
    OptionalProvider: "OpenRouter"
    ExampleModels:
      - "google/gemma-3n-e2b-it:free"
      - "mistral-small-instruct"
    LLMScope:
      - Intent Parsing
      - Explanation Assistance
      - Non-Deterministic Computation Disabled

  DevOps:
    Hosting: "Vercel"
    SourceControl: "GitHub"
    CICD: "Automatic Build on Commit"
    BuildValidation: "next build"
    Environments:
      - Production
      - Preview

Deployment:

  HostingProvider: "Vercel"
  Characteristics:
    - Automatic Builds from GitHub
    - Production and Preview Environments
    - Build-Time Validation
    - Hydration-Safe Client Pages
  PreviousDemoMethod:
    - Cloudflare Tunnel
  MigrationReason:
    - Stable Hosting
    - Reliable Demo Access
    - CI/CD Integration

DataSafety:
  TelemetryType: "Synthetic"
  Guarantees:
    - No Production Logs
    - No Customer Data
    - No Proprietary Systems

Roadmap:
  - ClickHouse Backend Integration
  - Time-Series Anomaly Detection
  - Blast Radius Estimation
  - Confidence Scoring
  - Metrics Export and Observability
  - LLM-Assisted Explanation Layer
  - Rate Limiting and Authentication Hardening

EngineeringPhilosophy:
  Principles:
    - Deterministic Metrics Before AI Reasoning
    - Reproducibility Over Opacity
    - Separation of Control and Computation
    - Explainable Summaries
    - Production-First Deployment Validation