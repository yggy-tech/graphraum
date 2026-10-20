# Edge Boundary Trim + Typed Springs — Design Spec

**Date:** 2026-09-03  
**Status:** Approved for planning  
**Issue:** [#111](https://github.com/yggy-tech/graphraum/issues/111)  
**Delivery:** One Graphraum release; Yggdrasil Graph Lab consumes afterward (Lab companion spec under yggdrasil `docs/superpowers/specs/2026-09-03-graph-lab-typed-springs-edge-polish-design.md`)

---

## Problem

1. **Edge attachments look crude.** Edges use node **centers** as endpoints. Nodes draw on top, so lines vanish under the fill and die against the stroke with no intentional join.
2. **Force layout is one-size-fits-all.** `ForceSettings` exposes a single `linkDistance` / `springStrength` / `repulsion` for the whole graph. Hosts cannot make some relations shorter/stiffer than others.

## Goals

1. Trim edge endpoints to the **node boundary** (with a small clearance) so joins look intentional.
2. Keep the **two-draw-call** edge/node baseline; trim happens at pack / sample time on the CPU.
3. Allow **per-edge spring parameters** (distance + strength) on `createForceSimulation` / `computeForcePositions`.
4. Stay **ontology-agnostic**: the host maps relation → numbers; Graphraum only applies arrays.
5. Default behavior unchanged when new options are omitted (except boundary trim default **on** — see Decision log).

## Non-goals

- Typed **repulsion** by node type (follow-up).
- Rules keyed by endpoint type pairs (follow-up; Lab may layer later).
- Lab UI / settings panels.
- Orthogonal / stepped paths.
- Changing marker shape catalog.
- Edge bundling.

## Approach

### A. Boundary trim

Before sampling path segments (and placing markers), resolve geometric endpoints:

1. Start from node centers (current behavior).
2. For each end, intersect the chord (or first/last path tangent for curves) with the node outline given `shape` + `size`/`width`/`height` + `strokeWidth`.
3. Pull back along the outward direction by a fixed **clearance** in world units (default ~0.5–1.0, clamped so short edges do not invert).
4. Sample path / place markers from the trimmed points.

Supported outlines for v1: `circle`, `diamond`, and axis-aligned rect / rounded-rect half-extents (same occupancy idea as picking). Unknown shapes fall back to circle of `max(width, height) / 2`.

**Public opt-out** on theme or pack options:

```ts
endpointAttach?: "boundary" | "center"; // default "boundary"
```

### B. Typed springs (per-edge)

Extend `ForceLayoutRequest`:

```ts
interface ForceLayoutRequest {
  dimensions: 2 | 3;
  edges: Uint32Array; // pairs of node indices
  nodeCount: number;
  iterations?: number;
  settings?: ForceSettings; // global defaults
  /** One value per edge (edges.length / 2). Omitted → settings.linkDistance for all. */
  linkDistances?: Float32Array;
  /** One value per edge. Omitted → settings.springStrength for all. */
  springStrengths?: Float32Array;
}
```

Validation:

- If provided, `linkDistances.length` and `springStrengths.length` must equal `edges.length / 2`.
- Values clamped with the same ranges as global `normalizeForceSettings`.
- Mismatch → throw with a clear message (no silent truncate).

Spring force loop uses per-edge distance/strength; repulsion and center attraction stay global.

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Trim default | `boundary` | Matches Lab product ask; `center` preserved for benchmarks / debugging |
| Engine knows relations? | No | Host resolves predicate → floats |
| Typed repulsion in this release? | No | Springs first |
| Per-edge arrays vs rule table in engine | Arrays | Keeps engine dumb and fast |

## Testing

- Unit: trim for circle/diamond/rect; clearance does not invert short edges; markers sit on trimmed ends.
- Unit: per-edge distance changes rest length vs global-only control.
- Unit: omitted arrays ≡ current global behavior.
- Regression: `path: "straight"` still one segment after trim; cubic sample count unchanged.
- Manual / explore: dense graph joins look clean at rim.

## Follow-ups

- Typed repulsion multipliers by node index or type (host-resolved).
- Optional fan-out for multi-edges between the same pair.
- Docs Explorer control for `endpointAttach`.
