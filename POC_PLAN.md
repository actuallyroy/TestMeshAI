# TestMeshAI POC Plan

## 1. Scope Reset

The first build should not be an MVP platform. It should be a local-first proof of concept that answers one question:

Can we point TestMeshAI at a JS/TS codebase, extract testable entities, visualize them, and run selected code paths without building backend infrastructure first?

If the answer is yes, then the broader platform is worth building.

---

## 2. What Storage Do We Actually Need?

For the POC, almost none.

### We do not need

* PostgreSQL
* Redis
* object storage
* background job persistence
* historical run storage
* confidence scoring history

### We only need

* In-memory application state while the app is open
* Optional browser local storage or IndexedDB for:
  * recent project paths
  * cached parse results
  * saved example inputs

### Why storage existed in the earlier architecture

That storage was for the platform version of the product:

* storing indexed project versions
* storing entity graphs
* storing run histories and artifacts
* comparing regressions across time
* multi-project and multi-user support

None of that is required to prove the core loop.

---

## 3. POC Goal

Build an offline web app that:

1. takes a local JS/TS codebase
2. parses files into entities and edges
3. shows a graph or entity explorer
4. lets the user run a selected function or API handler locally
5. shows inputs, output, error, and basic dependency trace

That is enough to validate the product direction.

---

## 4. POC Architecture

Use a very small two-part local architecture.

## 4.1 Web App

Responsibilities:

* project picker
* entity explorer
* graph view
* test input form
* run result panel

Suggested stack:

* Next.js or Vite
* React
* TypeScript
* React Flow for graph rendering

## 4.2 Local Runtime Bridge

Responsibilities:

* read local files
* parse TS/JS codebase
* resolve imports
* execute selected functions locally
* return output/errors back to the UI

Suggested implementation:

* Node.js local service started by the app
* TypeScript Compiler API or `ts-morph`
* `tsx` or `esbuild-register` style execution for TS support

This is still an offline web app from the user’s perspective. It just has a local helper process because browser-only file system access and code execution are too constrained for this use case.

---

## 5. Why Not Browser-Only?

Pure browser execution breaks down quickly because the app needs to:

* read arbitrary project files recursively
* resolve imports across the repo
* execute Node-oriented code
* support filesystem and environment assumptions from the target project

So the practical POC is:

* web UI in browser
* local Node engine on the same machine

That keeps the experience offline while staying technically credible.

---

## 6. POC Features

## 6.1 Codebase Load

Input:

* local project path

Output:

* file inventory
* extracted entities
* extracted edges

Limit scope to:

* TypeScript
* JavaScript
* ESM/CommonJS where reasonably supported

## 6.2 Entity Extraction

Extract initially:

* exported functions
* class methods
* simple API route handlers

Metadata:

* name
* file path
* symbol path
* params
* return type if inferable
* direct dependencies/imports

## 6.3 Graph View

Show:

* nodes for entities/modules
* edges for imports/calls
* click-through to entity details

The graph only needs to be useful, not complete.

## 6.4 Single-Entity Run

Support:

* manual JSON input
* run selected exported function
* show returned value or thrown error

This is the critical proof point.

## 6.5 Basic Flow Run

Only after single-entity run works.

Support a very small flow model:

* step 1 calls function A
* output maps into function B
* result displayed in sequence

Do not build a full DSL yet.

---

## 7. What We Should Explicitly Skip

Not for POC:

* hosted backend
* multi-user projects
* auth
* cloud storage
* CI integration
* UI semantic modeling
* browser automation
* confidence score
* full mocking system
* regression history
* container sandboxing

If we build these now, we will spend time proving infrastructure instead of proving product value.

---

## 8. Minimal Runtime Model

The local runtime can expose a small API:

* `loadProject(path)`
* `scanEntities(path)`
* `getEntity(id)`
* `runEntity(id, input)`

Optional later:

* `runFlow(steps)`

Return shapes should stay simple:

* entity metadata
* graph nodes/edges
* run result
* stack trace
* execution duration

---

## 9. Minimal Internal Data Shapes

Example entity:

```json
{
  "id": "src/math/add.ts#add",
  "kind": "function",
  "name": "add",
  "filePath": "src/math/add.ts",
  "exportName": "add",
  "params": [
    { "name": "a", "type": "number" },
    { "name": "b", "type": "number" }
  ],
  "returnType": "number",
  "dependencies": ["src/math/shared.ts#coerce"]
}
```

Example run result:

```json
{
  "status": "passed",
  "output": 3,
  "error": null,
  "durationMs": 12
}
```

---

## 10. Recommended Build Order

1. Create local UI shell
2. Build Node parser service for JS/TS entity extraction
3. Render entity list from a chosen project path
4. Add graph rendering from extracted edges
5. Add function execution path for exported functions
6. Add JSON input editor and result panel
7. Add very basic chained two-step flow runner

This order proves the product quickly and keeps failures obvious.

---

## 11. Suggested Repo Shape For POC

```text
testmeshai/
  app/
    web/
    local-engine/
  packages/
    parser-ts/
    shared-types/
```

This is enough. Do not split further yet.

---

## 12. Success Criteria

The POC is successful if, on one local JS/TS repo, a user can:

* load the repo
* see meaningful extracted entities
* click a function
* provide input
* run it
* inspect output or failure without opening the source code

If that works well, then storage, history, confidence, and collaboration become justified next steps.
