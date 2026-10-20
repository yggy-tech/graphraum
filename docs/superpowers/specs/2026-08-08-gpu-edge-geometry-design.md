# GPU Edge Geometry — Design Spec

**Date:** 2026-08-08  
**Status:** Approved for planning  
**Issue:** [#30](https://github.com/yggy-tech/graphraum/issues/30) (next delivery slice after typed presentations, SDF node shapes, and bounded DOM overlay)  
**Related:** [#11](https://github.com/yggy-tech/graphraum/issues/11) LOD, [#16](https://github.com/yggy-tech/graphraum/issues/16) incremental updates, [#9](https://github.com/yggy-tech/graphraum/issues/9) performance roadmap

---

## Problem

Edges still render through `LineSegments` + `LineBasicMaterial`. Width is platform-limited, dash and direction markers are unavailable, and product graphs cannot express directed / weighted relationships without leaving the batched path.

Issue #30’s remaining renderer slice is GPU edge geometry that stays inside graphraum’s two-draw-call budget and works with viewport LOD.

## Goals

1. Expressive edge visuals: color, width, opacity, line style, and customizable markers.
2. Ultra-performant defaults via LOD: overview stays cheap; detail appears when zoomed or focused.
3. Same public contract in **2D and 3D** (screen-space width, billboarded like nodes).
4. Preserve **two draw calls** (nodes + edges) and framework-neutral APIs.
5. Keep topology coordinates separate from visuals: endpoints come from node positions.

## Non-goals

- Edge aggregation / bundling / supernode links (future #11 work).
- Custom shader modules or arbitrary Three materials.
- HTML overlays on edges.
- Completing every #16 style-only edge update path in this PR (append/full replace + layout-driven endpoint updates are in scope; a dedicated edge style patch API may follow).
- Rust/Wasm layout or renderer backend swaps (#12 / #13).

## Approach

**Instanced segments + marker instances (Approach A).**

One `InstancedMesh` and one edge material. Instance kinds:

- `segment` — stroke between source and target
- `marker` — filled triangle (v1) placed at configured ends

Markers are separate instances so LOD can drop them first without rewriting stroke geometry. Dash/opacity/width live in segment instance attributes.

## Public contract

Extend `GraphraumEdgeVisual` (compiled outside the render loop via `defineVisuals` or direct edge fields):

```ts
type GraphraumEdgeStyle = "solid" | "dashed" | "dotted";
type GraphraumEdgeMarker = "none" | "triangle";
type GraphraumEdgeMarkerEnd = "target" | "source" | "both";

interface GraphraumEdgeVisual {
  color?: GraphraumColor;
  width?: number; // screen-space px
  opacity?: number; // 0..1
  style?: GraphraumEdgeStyle; // default "solid"
  marker?: GraphraumEdgeMarker; // default "none"
  markerSize?: number; // scale relative to width, default 1
  markerEnd?: GraphraumEdgeMarkerEnd; // default "target" when marker !== "none"
}
```

Theme defaults:

- keep `edge` color
- add `edgeWidth` and `edgeOpacity`

Topology remains on the edge (`source` / `target` ids). Positions are resolved from node slots. The mapper never invents edge coordinates.

Validation at compile time (actionable errors with edge id):

- `width` / `markerSize` positive finite
- `opacity` in `[0, 1]`
- unknown `style` / `marker` / `markerEnd` rejected

Selection / focus must not mutate source graph data (existing interaction-state rule).

## Renderer

Replace `LineSegments` + `LineBasicMaterial` with:

- unit quad (or triangle pair) geometry
- custom edge `ShaderMaterial` shared by segment and marker instances
- instance attributes for endpoints, width, rgba, dash parameters, and kind/size

Screen-space width in both modes, following the node billboard pattern in `node-rendering.ts`.

Capacity:

- geometric growth for segment slots (bounded by `maxVisibleEdges`)
- marker capacity sized for directed ends (`markerEnd: "both"` ⇒ up to two markers per edge)
- diagnostics expose `segmentCount`, `markerCount`, and draw-call count (still 2)

## LOD materialization

Extend the existing viewport materialize path (`viewport-lod` + `materializeViewport`):

1. Collect incident edge candidates for visible nodes.
2. Apply edge budget (`maxVisibleEdges`).
3. Apply detail tier:
   - **overview** — segments only; force `solid`; theme/default width; markers omitted
   - **exploration** — honor width/opacity/dash; markers for edges with `marker !== "none"`
   - **detail / focus** — full marker kind, size, and ends
4. Pack compacted segment (+ marker) instances into GPU slots.
5. Prefer degradation order when under budget pressure: drop markers → simplify dash to solid → thin width → cut edge count.

This is progressive attribute/instance budgeting on one batched path, not additional materials.

## Data flow

```text
defineVisuals / edge fields
        │
        ▼
 compileGraph ── validate + freeze visuals
        │        endpoint indices from node ids
        ▼
 canonical edge style + endpoint buffers
        │
        ▼
 materializeViewport (LOD tier)
        │
        ├── segment instances
        └── marker instances
        │
        ▼
 single edge InstancedMesh draw
```

Update paths in this slice:

- `setData` — full rebuild
- `applyDataPatch` append-within-capacity — pack new edge styles into free slots
- `updateNodes` / `applyLayout` — rewrite affected segment/marker endpoint attributes only

Removals that force full rebuild today may continue to rebuild; stable free-list compaction for removals can land with #16 follow-up if not cheap here.

## Testing

- Unit: compile validation for new edge visual fields
- Unit: packing counts for `marker: "none" | "triangle"` × `markerEnd`
- Unit: overview LOD suppresses markers; detail keeps them
- Unit/integration: diagnostics still report 2 draw calls
- Docs/lab: expose edge width, opacity, style, marker controls

Manual: verify width and markers in 2D and 3D on the laboratory / proof lab.

## Acceptance

- Public types and mapper examples documented
- Edge mappings compile outside the render loop
- Width, opacity, dash, and triangle markers behave consistently in 2D and 3D
- Overview LOD omits markers by default; detail restores them
- Invalid visuals fail with actionable errors
- Baseline remains two draw calls
- Benchmark tiers remain runnable (1k / 10k / 100k); no silent regression to per-edge meshes

## Delivery

Single focused PR against #30 titled around GPU edge geometry. Link follow-ups for:

- dedicated edge style patch API (#16)
- aggregation / bundling (#11)
- additional marker kinds beyond `triangle` when a product need appears
