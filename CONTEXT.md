# Pui

An OpenTUI client for Pi that bundles feature modules (subagents, workflows, web, file search) and exposes them to the Pi model through extension adapters.

## Language

### Architecture

**Module**:
A self-contained feature (subagents, workflows, web, file search) owning its logic, state, and wire protocols. Modules never import each other; they may import Shared Primitives.
_Avoid_: feature, extension (for the whole feature)

**Extension**:
The thin adapter a Module exposes to register its tools with the Pi process. Lives inside the Module; Pi Core loads it via the Register File. Built into pui, never used as a standalone `pi` extension.
_Avoid_: plugin

**Pi Core**:
The layer that owns the Pi session lifecycle and all registration concerns — tools, skills, AGENTS.md guidance.
_Avoid_: host, controller (for the whole layer)

**App**:
The process layer: entry points, CLI parsing, and pui process management. Orchestrates Pi Core and the UI but contains no UI logic.
_Avoid_: host, main

**Controller**:
The UI's state layer, folding session events into renderable state. Part of the UI, not the App.
_Avoid_: app controller, view model (for the layer)

**Register File**:
Pi Core's composition root that lists every Extension to load. The only place tool/skill registration happens.
_Avoid_: bundled extensions

**Shared Primitive**:
Reusable infrastructure any Module may depend on (e.g., the Child-Agent Runtime). Not a feature by itself.
_Avoid_: shared extension, common code

**Child-Agent Runtime**:
The Shared Primitive for spawning and supervising child Pi processes: invocation, NDJSON streaming, the process-wide semaphore, and Agent Roles. Consumed by both the subagents and workflows Modules.
_Avoid_: subagent (for the primitive), shared subagent

**Agent Role**:
A named child-agent configuration (model, timeout, guidance) owned by the Child-Agent Runtime — `worker`, `explore`, or `generic`. Not subagent-specific.
_Avoid_: preset (bare), subagent role

**Interfaces Directory**:
The only part of a Module importable from outside it. Holds the Module's Extension, UI Entry, Host Entry, and (where offered) public authoring API; everything else in the Module is private.
_Avoid_: public folder, exports folder

**Host Entry**:
The interface a Module exports for the App layer's host-process needs (e.g., headless runs), distinct from its Extension.
_Avoid_: bridge

**UI Entry**:
The observation-shaped interface a Module exports for the OpenTUI layer (view models, protocol parsers, change events). The only way UI code may reach a Module.
_Avoid_: bridge, view model file (as a location)
