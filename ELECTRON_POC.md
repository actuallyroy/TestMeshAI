# TestMeshAI Electron POC

## Why Electron

Electron is the right shape for the first real build because the product needs both:

* desktop-grade access to local codebases
* a modern UI for graph inspection and test execution

That removes the mismatch from a browser-only app while keeping the experience local-first and offline-capable.

## POC Boundaries

The Electron POC should prove four capabilities:

1. choose a local JS/TS project directory
2. scan the codebase for exported functions
3. show extracted entities in a desktop UI
4. execute a selected exported function with JSON input

## Process Model

### Main Process

Owns:

* native file/directory picking
* filesystem access
* project scanning
* entity execution
* IPC handlers

### Preload Layer

Owns:

* safe bridge from renderer to main process

### Renderer

Owns:

* entity inventory UI
* future graph view
* input editor
* result panel

## Why This Is Better Than The Earlier POC Shape

The local Node helper and the web UI now ship together:

* one application
* one install surface
* no local service management
* cleaner offline story

## Current Scaffold

The scaffold in this repo now includes:

* Electron main process
* preload bridge
* React renderer
* basic project scanner
* basic exported-function runner

## Current Limits

The scanner and runner are intentionally crude right now:

* regex-based export detection
* no AST graph yet
* no robust module transpilation path yet
* last scanned project held in memory only

Those are acceptable POC shortcuts.

## Next Technical Steps

1. replace regex extraction with TypeScript AST parsing
2. add import/dependency edges
3. make execution work reliably across TS projects using a controlled transpile/load path
4. add a simple graph panel
5. add API handler detection
