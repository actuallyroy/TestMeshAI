# TestMeshAI Architecture Plan

## 1. Purpose

This document converts the PRD into a buildable system architecture for an MVP and a clear path beyond MVP.

The core product idea is:

1. Extract testable entities from a codebase.
2. Represent them as a graph.
3. Let users run entities and composed flows through one execution model.
4. Observe failures, history, and confidence from a single system.

---

## 2. North-Star Architecture

TestMeshAI should be built as a modular platform with a single product surface and multiple execution adapters behind it.

### Recommended shape

* Frontend application for graph visualization, test authoring, and execution inspection
* Backend API for project management, entity graph, runs, histories, and confidence computation
* Worker runtime for sandboxed execution of tests and flows
* Parser/indexer pipeline for extracting entities and dependencies from source code
* Storage layer for metadata, graph structure, run artifacts, and event timelines

### Recommended deployment model

Start as a modular monolith with background workers, not microservices.

Reason:

* The domain is still evolving quickly
* Graph, execution, and history models will change together
* A monolith reduces integration cost for MVP
* Workers can still scale independently when execution volume grows

---

## 3. Proposed Stack

## Frontend

* Next.js
* React
* TypeScript
* React Flow for graph editing and visualization
* Tailwind or a small design system for fast UI assembly

## Backend

* Node.js + TypeScript
* NestJS or Fastify-based service structure
* BullMQ or a similar queue for background execution jobs

## Execution Runtime

* Node worker runtime for JS/TS MVP
* Containerized execution for isolation
* Playwright adapter for UI flow execution

## Storage

* PostgreSQL for core relational data
* Redis for queues, locks, and ephemeral run coordination
* Object storage for logs, traces, snapshots, and larger artifacts

## Parsing / Analysis

* TypeScript Compiler API or `ts-morph` for AST extraction
* Optional Babel fallback only if needed for non-TS JS edge cases

---

## 4. Core System Modules

## 4.1 Project Ingestion Service

Responsibility:

* Register a repo or local project
* Track branches/commits for indexing
* Trigger parse/index jobs

Inputs:

* Project metadata
* Source paths
* Commit hash

Outputs:

* Indexed project version
* Parse tasks

## 4.2 Entity Extraction Engine

Responsibility:

* Parse source code
* Identify entities
* Infer signatures and dependencies
* Emit graph-ready metadata

Entity types for MVP:

* Function
* Class method
* API route
* Module

Entity types after MVP:

* UI component
* UI semantic element
* External service dependency
* Queue consumer / scheduled job

Output example:

* Entity id
* Entity type
* Name
* File path
* Export path
* Input schema
* Output schema
* Dependency edges
* Source location

## 4.3 Graph Engine

Responsibility:

* Maintain canonical graph of entities and interactions
* Support graph queries for domain expansion and failure localization
* Store both static edges and runtime edges

Edge categories:

* `calls`
* `depends_on`
* `exposes`
* `triggers`
* `renders`
* `contains`
* `observed_runtime_call`

Important constraint:

Do not treat the graph as just a visualization artifact. It must be a first-class backend model that drives execution, drill-down, and confidence scoring.

## 4.4 Test Definition Service

Responsibility:

* Store executable test blocks and composed domains
* Resolve referenced entities
* Version test definitions

Test object types:

* Entity test
* Domain test
* Flow test
* UI flow test

Each test definition should be declarative, not imperative code by default.

That keeps authoring stable and allows AI generation, replay, diffing, and visualization.

## 4.5 Execution Orchestrator

Responsibility:

* Plan runs
* Expand a domain into execution steps
* Schedule steps serially or in parallel
* Apply mocks and environment config
* Emit timeline events

This service should be stateless except for queue coordination and run progress updates.

## 4.6 Runtime Adapters

Responsibility:

* Execute different test targets behind a common interface

Adapters for MVP:

* Function adapter
* API adapter

Adapters for phase 2/3:

* Playwright UI adapter
* Async workflow adapter
* Queue/job adapter

Common adapter contract:

* `prepare(context)`
* `execute(step)`
* `collectArtifacts()`
* `teardown()`

## 4.7 State and Mock Layer

Responsibility:

* Inject mocks
* Manage test fixtures
* Capture state snapshots
* Reset environment between runs

MVP support:

* HTTP mocking
* Environment overrides
* In-memory stubbed dependencies

Later support:

* Database snapshot/restore
* Queue stubbing
* Service virtualization

## 4.8 Observability and Failure Analysis

Responsibility:

* Persist event timelines
* Map failures back to graph nodes
* Detect regressions between runs

Artifacts:

* Step events
* Logs
* Structured assertions
* Stack traces
* Screenshots/videos for UI runs

## 4.9 Confidence Engine

Responsibility:

* Compute confidence by entity, domain, and project
* Blend coverage, recency, pass rate, and dependency confidence

Do not reduce confidence to raw coverage. A weighted model is more defensible.

---

## 5. Canonical Data Model

The backend should center on a few stable entities.

## 5.1 Project

Represents a codebase under analysis.

Fields:

* `id`
* `name`
* `repo_url` or local path
* `default_branch`
* `created_at`

## 5.2 ProjectVersion

Represents a specific indexed state.

Fields:

* `id`
* `project_id`
* `commit_sha`
* `index_status`
* `indexed_at`

## 5.3 Entity

Represents one testable node.

Fields:

* `id`
* `project_version_id`
* `kind`
* `name`
* `stable_key`
* `file_path`
* `symbol_path`
* `input_schema`
* `output_schema`
* `metadata`

## 5.4 Edge

Represents a graph relation.

Fields:

* `id`
* `project_version_id`
* `from_entity_id`
* `to_entity_id`
* `edge_type`
* `source`

`source` is either static analysis, user-defined, or runtime-observed.

## 5.5 TestDefinition

Represents a reusable test block or composed domain.

Fields:

* `id`
* `project_id`
* `kind`
* `name`
* `version`
* `definition_json`
* `created_by`

## 5.6 Run

Represents one execution.

Fields:

* `id`
* `project_version_id`
* `test_definition_id`
* `status`
* `started_at`
* `finished_at`
* `summary`

## 5.7 RunStep

Represents one executable step within a run.

Fields:

* `id`
* `run_id`
* `entity_id`
* `adapter_kind`
* `status`
* `input_payload`
* `output_payload`
* `started_at`
* `finished_at`

## 5.8 Artifact

Represents logs, traces, snapshots, screenshots, and other run artifacts.

Fields:

* `id`
* `run_id`
* `run_step_id`
* `artifact_type`
* `storage_url`
* `metadata`

## 5.9 ConfidenceRecord

Represents computed confidence over time.

Fields:

* `id`
* `scope_type`
* `scope_id`
* `score`
* `factors_json`
* `computed_at`

---

## 6. Execution Model

The execution model is the most important architecture decision in the product.

Use a unified run pipeline:

1. Resolve target test definition.
2. Expand definition into a directed execution plan.
3. Attach environment, mocks, and fixtures.
4. Dispatch steps to runtime adapters.
5. Stream events back to the backend.
6. Persist outputs and artifacts.
7. Compute assertions, failures, and confidence deltas.

### Why this matters

This keeps function tests, API tests, and UI flows under one run abstraction rather than separate subsystems with separate histories.

### Run states

* queued
* preparing
* running
* passed
* failed
* canceled

### Step states

* pending
* running
* passed
* failed
* skipped

---

## 7. Test Definition DSL

The product needs a declarative test definition format early.

Example shape:

```json
{
  "kind": "flow",
  "name": "signup flow",
  "nodes": [
    {
      "id": "step_1",
      "entity_ref": "ui:signup_form.email_input",
      "action": "type",
      "input": { "value": "user@example.com" }
    },
    {
      "id": "step_2",
      "entity_ref": "ui:signup_form.submit_button",
      "action": "click"
    },
    {
      "id": "step_3",
      "entity_ref": "api:POST_/signup",
      "assert": { "status": 201 }
    }
  ],
  "edges": [
    { "from": "step_1", "to": "step_2" },
    { "from": "step_2", "to": "step_3" }
  ]
}
```

Design rule:

The DSL should describe intent, not implementation details such as CSS selectors or framework-specific test code.

---

## 8. UI Entity Strategy

The PRD correctly identifies selector brittleness as a core problem. The architecture should handle this carefully.

### Recommendation

Do not attempt full selector-free UI modeling in MVP.

Instead:

* Build a semantic UI abstraction layer on top of Playwright
* Prefer accessibility roles, labels, and component metadata
* Allow explicit fallback locators when semantic mapping is insufficient

### Practical MVP model

Represent UI entities as:

* page
* form
* button
* input
* modal
* list

Each UI entity should carry:

* semantic name
* role
* page/container context
* allowed actions
* optional fallback locator

This is a credible path. A pure selectorless promise in v1 is not.

---

## 9. API Surface

Expose a backend API that mirrors the domain model.

Core endpoints:

* `POST /projects`
* `POST /projects/:id/index`
* `GET /projects/:id/graph`
* `GET /entities/:id`
* `POST /tests`
* `POST /runs`
* `GET /runs/:id`
* `GET /runs/:id/timeline`
* `GET /confidence/:scopeType/:scopeId`

Use REST for MVP. Add streaming for run progress through WebSockets or Server-Sent Events.

---

## 10. Frontend Architecture

Frontend should be organized around three primary surfaces.

## 10.1 Inventory View

Purpose:

* Browse extracted entities
* Inspect signatures and dependencies
* Launch single-entity tests

## 10.2 Graph View

Purpose:

* Visualize domains and interactions
* Compose flows
* Inspect failure propagation

## 10.3 Run Inspector

Purpose:

* Follow live execution
* Inspect timeline
* Compare current and historical results

Frontend state guidance:

* Server state in React Query or equivalent
* Local composition state in React state/store
* Avoid over-modeling frontend state until graph editing proves stable

---

## 11. Security and Isolation

This product executes untrusted project code. Isolation is not optional.

Baseline requirements:

* Containerized execution per run or run group
* CPU and memory limits
* Network policy control
* Secret scoping per project/environment
* Artifact redaction support

For MVP, local single-tenant execution is acceptable if clearly framed as development mode.

---

## 12. Scalability Path

Scale execution before scaling metadata services.

Expected bottlenecks:

* Run concurrency
* UI/browser execution cost
* Artifact storage volume
* Graph query performance on large repos

Recommended path:

1. Start with PostgreSQL adjacency tables for graph storage.
2. Add graph-oriented materialized views for common traversals.
3. Introduce a dedicated graph database only if query patterns justify it.

Do not start with Neo4j unless graph complexity becomes the actual bottleneck.

---

## 13. Confidence Score Model

Use a weighted score, for example:

* 35% recent pass rate
* 25% direct entity coverage
* 20% dependency confidence
* 10% assertion strength
* 10% recency decay

The exact formula can evolve, but the architecture should store factor breakdowns so the score is explainable.

If the score is not explainable, users will not trust it.

---

## 14. MVP Definition

The MVP should prove one strong loop:

1. Ingest TS/JS repo
2. Extract functions and API routes
3. Let user run entity-level tests
4. Compose simple multi-step flows
5. Show graph + timeline + failure node

### MVP modules

Build now:

* Project ingestion
* TS/JS parser
* Entity store
* Edge store
* Test definition store
* Execution orchestrator
* Function/API adapters
* Run inspector UI

Do later:

* Rich AI generation
* Full UI semantic extraction
* Multi-language support
* CI integrations
* Production monitoring bridges

---

## 15. Suggested Repo Structure

```text
testmeshai/
  apps/
    web/
    api/
    worker/
  packages/
    domain/
    parser-ts/
    graph/
    execution/
    adapters-function/
    adapters-api/
    adapters-playwright/
    test-dsl/
    confidence/
    shared/
  infra/
    docker/
    migrations/
```

Why this structure:

* Clear app/package separation
* Shared domain contracts stay centralized
* Execution adapters remain modular
* Monolith can evolve toward service extraction later

---

## 16. Phase Plan

## Phase 1: Entity Testing

Deliver:

* TS/JS parser
* Function and API extraction
* Entity detail screen
* Manual run with inputs
* Run result view

Success condition:

User can validate an unfamiliar function or endpoint without opening source code.

## Phase 2: Domains and Graph

Deliver:

* Graph view
* Domain composition
* Multi-step flow execution
* Failure localization
* Regression history

Success condition:

User can isolate a failing feature path to a specific graph node.

## Phase 3: UI and Async Systems

Deliver:

* Playwright-backed UI entity model
* Queue/job step support
* Snapshotting and richer mocks

Success condition:

User can run a realistic full-stack path with minimal handwritten test code.

---

## 17. Key Architecture Decisions

### ADR-1: Modular monolith first

Decision:

* Use one backend codebase with background workers

Why:

* Faster iteration on a changing domain

### ADR-2: Declarative test definitions

Decision:

* Store tests as JSON DSL, not only executable code

Why:

* Necessary for AI generation, graph mapping, replay, and explainability

### ADR-3: Unified run abstraction

Decision:

* All test types become `Run` plus `RunStep`

Why:

* Prevents fragmentation across function/API/UI systems

### ADR-4: PostgreSQL before graph database

Decision:

* Store graph in relational tables first

Why:

* Lower operational cost and enough for MVP traversal patterns

### ADR-5: Semantic UI layer over Playwright

Decision:

* Use Playwright as the execution base and add semantic metadata above it

Why:

* More realistic than inventing a selectorless runtime from scratch

---

## 18. Open Questions

These should be answered before implementation starts in earnest.

1. Will projects be local-only first, or connected to remote Git providers?
2. Is the first user persona an individual developer or a team workspace?
3. How much code execution isolation is required in v1: local dev only, or hosted multi-tenant?
4. Should assertions remain declarative only, or allow custom code assertions in an escape hatch?
5. How should confidence be surfaced: per entity, per domain, per branch, or all three?

---

## 19. Recommended First Build Slice

If starting implementation now, build in this order:

1. Monorepo scaffold with `web`, `api`, `worker`, and shared packages
2. PostgreSQL schema for projects, entities, edges, tests, runs, and artifacts
3. TS parser that indexes functions and API routes
4. API endpoints for listing entities and creating runs
5. Worker that executes function/API adapters
6. Web UI for entity list, entity details, and run inspector
7. Basic graph visualization from stored edges

This sequence proves the product loop early without overcommitting to the hardest parts too soon.
