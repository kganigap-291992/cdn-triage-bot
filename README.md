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
      - Chat input may propose/override filters
      - Execution remains deterministic via /api/triage
      - LLM is not trusted for metric computation
    ExecutionPolicy: >
      LLM may assist in intent parsing and explanations only.
      All metrics and decisions are computed deterministically.
      Optional: triage execution is either user-triggered or explicitly requested via intent.
    ExampleInputs:
      - "run triage"
      - "svc=live region=use1 win=60"

CurrentSystemArchitecture:
  Diagram: |
    flowchart LR
        A[Browser UI] --> B[Next.js App Router]
        A --> LS[LocalStorage: run history + chat mode]

        B --> C[/api/triage]
        B --> X[/api/chat (optional LLM assist)]
        B --> Y[/api/demo-login + /api/demo-logout]

        C --> D[Metrics Engine]
        D --> E[Structured Summary]
        D --> F[Raw Metrics JSON]

        subgraph Data Layer
            G[CSV Telemetry (synthetic)]
            H[ClickHouse (planned)]
        end

        C --> G
        C -. future .-> H

TechnologyStack:

  Frontend:
    Framework: "Next.js (App Router)"
    Language: "TypeScript"
    UILibrary: "React"
    StateManagement: "LocalStorage (Run History + UI prefs)"
    RenderingStrategy: "Hydration-Safe Client Rendering"

  Backend:
    APILayer: "Next.js API Routes"
    Runtime: "Node.js (Vercel Serverless)"
    AnalyticsLayer: "Custom Deterministic Metrics Engine"

  DataLayer:
    DemoSource: "Synthetic CSV Telemetry"
    ProductionTarget: "ClickHouse (Planned)"

  ConversationalLayer:
    CurrentMode: "Deterministic Parser"
    OptionalProvider: "OpenRouter"
    ExampleModels:
      - "google/gemma-3n-e2b-it:free"
      - "<add exact openrouter model id>"
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
  OperationalConstraints:
    - Serverless cold starts possible
    - API request timeouts apply
    - Large CSV uploads should be bounded or moved to object storage in future

DataSafety:
  TelemetryType: "Synthetic"
  Guarantees:
    - No Production Logs
    - No Customer Data
    - No Proprietary Systems
  Notes: >
    Synthetic generator is designed to mimic operational patterns without leaking identifiers.

Roadmap:
  - ClickHouse Backend Integration (real query layer)
  - Authentication + Rate Limiting
  - Observability (metrics export / logging)
  - Time-Series Anomaly Detection
  - Blast Radius Estimation
  - Confidence Scoring
  - LLM-Assisted Explanation Layer (strictly non-computational)

EngineeringPhilosophy:
  Principles:
    - Deterministic Metrics Before AI Reasoning
    - Reproducibility Over Opacity
    - Separation of Control and Computation
    - Explainable Summaries
    - Production-First Deployment Validation
