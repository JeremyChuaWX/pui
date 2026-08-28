# Pui

An OpenTUI client for Pi that bundles feature modules (subagents, web, file search) and exposes them to the Pi model through extension adapters.

## Language

### Architecture

**Module**:
A self-contained feature (subagents, web, file search) owning its logic, state, and wire protocols. Modules never import each other; they may import Shared Primitives.
_Avoid_: feature, extension (for the whole feature)

**Extension**:
The thin adapter a Module exposes to register its tools with the Pi process. Lives inside the Module; Pi Core loads it via the Register File. Built into pui, never used as a standalone `pi` extension.
_Avoid_: plugin

**Pi Core**:
The layer that owns the Pi session lifecycle and all registration concerns — tools, skills, AGENTS.md guidance.
_Avoid_: host, controller (for the whole layer)

**App**:
The process layer: entry points, CLI parsing, and pui process management. Orchestrates Pi Core and the UI but contains no UI logic and never imports a Module.
_Avoid_: host, main

**Controller**:
The UI's state layer, folding session events into renderable state. Part of the UI, not the App.
_Avoid_: app controller, view model (for the layer)

**Register File**:
Pi Core's composition root that lists every Extension to load. The only place tool/skill registration happens.
_Avoid_: bundled extensions

**Shared Primitive**:
Reusable infrastructure that at least two Modules depend on (retained output, bounded processes, validation). Not a feature by itself; code with one consumer lives in that consumer's Module.
_Avoid_: shared extension, common code

**Interfaces Directory**:
The only part of a Module importable from outside it. Holds the Module's Extension and, where the UI needs one, its UI Entry; everything else in the Module is private.
_Avoid_: public folder, exports folder, host entry

**UI Entry**:
The observation-shaped interface a Module exports for the OpenTUI layer (view models, protocol parsers, change events). The only way UI code may reach a Module.
_Avoid_: bridge, view model file (as a location)

### Subagents

**Profile**:
A named child-agent configuration owned by the subagents Module: tools, model, prompt, and limits. The two Profiles are `explorer` and `worker`.
_Avoid_: agent role, preset, role, generic

**Job**:
One spawned child Pi process running under a Profile, tracked from queued through terminal state.
_Avoid_: run, subagent (for the instance), task

**Limits**:
The three watchdogs every Job runs under: the whole-job wall clock, the stall timeout while no tool is active, and the tool-stall timeout while one is.
_Avoid_: timeout (bare)

**Background Protocol**:
The versioned, bounded snapshot stream a Job publishes for the UI Entry, plus the matching control channel for cancellation.
_Avoid_: progress protocol, jobs channel
