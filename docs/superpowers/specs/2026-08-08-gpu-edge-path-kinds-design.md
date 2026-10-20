# GPU Edge Path Kinds — Design Spec

**Date:** 2026-08-08  
**Status:** Approved for planning  
**Issue:** [#80](https://github.com/yggy-tech/graphraum/issues/80) (edge-path slice after GPU shape catalog)  
**Related:** [#79](https://github.com/yggy-tech/graphraum/pull/79) GPU edges, [#81](https://github.com/yggy-tech/graphraum/issues/81) rich HTML focus, [#82](https://github.com/yggy-tech/graphraum/issues/82) fidelity ADR

---

## Problem

Batched edges support width, opacity, dash, and markers, but only as **straight** segments. Product graphs need bowed and S-curve edges without leaving the single edge draw call or filling the GPU with off-screen geometry.

## Goals

1. Public path kinds: `straight` | `quadratic` | `cubic`.
2. Explicit `controlPoints` in world space, with deterministic auto defaults when omitted.
3. Compile curves to polylines of existing segment instances (one edge draw call).
4. Tiered cost: overview collapses to one straight segment; detail uses fixed sample counts.
5. Viewport culling first — off-screen edges never allocate segments.
6. Document + laboratory / playground controls.

## Non-goals

- `step` / orthogonal paths (later #80 follow-up).
- Adaptive sample counts by screen length.
- GPU Bezier evaluation in the vertex shader.
- Arc-length-continuous dashes across segments.
- Edge bundling / aggregation.
- Rich HTML/SVG edges (#81).

## Approach

**CPU sample → existing segment instances.**

At pack time, resolve path + controls, sample the curve into a polyline, and emit one `EdgeSegmentInstance` per span into the current edge `InstancedMesh`. Markers stay separate instances oriented by the first/last segment tangent.

## Public contract

```ts
type GraphraumEdgePath = "straight" | "quadratic" | "cubic";

interface GraphraumEdgeVisual {
  // existing: color, width, opacity, style, marker, markerSize, markerEnd
  path?: GraphraumEdgePath; // default "straight"
  controlPoints?: readonly GraphraumPosition[]; // world space
}
```

Validation (compile-time, actionable errors with edge id):

| path | `controlPoints` omitted / `[]` | provided |
|------|-------------------------------|----------|
| `straight` | ignore | ignore |
| `quadratic` | auto (1 point) | must be length **1** |
| `cubic` | auto (2 points) | must be length **2** |

Unknown `path` rejected like other enums. Control point coordinates must be finite.

### Auto defaults

- **Quadratic:** one control at the chord midpoint, offset perpendicular to the XY chord by a fixed fraction of chord length (deterministic; V1 no multi-edge fan-out).
- **Cubic:** two handles at ⅓ and ⅔ along the chord, offset on opposite sides of the chord by the same fraction (gentle S-curve).

Z for auto controls: lerp endpoints’ z at the corresponding parameter.

## Compile, LOD, sampling

Extend `packEdgeInstances`:

1. Resolve endpoints from node positions.
2. Resolve `path` + `controlPoints` (or auto).
3. **Overview:** force `path = straight`, one segment, skip markers (unchanged LOD policy).
4. **Detail:** sample equal-`t` polylines:
   - `straight` → 1 segment  
   - `quadratic` → **8** segments  
   - `cubic` → **12** segments  
5. Emit segments sharing color / width / opacity / style.
6. Markers only in detail, at true endpoints, direction from first/last segment.

Dash remains per-segment in V1.

## Capacity, culling, diagnostics

- Viewport candidates first; off-screen edges allocate nothing.
- `maxVisibleEdges` still caps **edges**, not segments.
- Instance capacity:

```ts
DETAIL_MAX_SEGMENTS = 12; // cubic
segmentCapacity = edgeCapacity * DETAIL_MAX_SEGMENTS;
markerCapacity = edgeCapacity * 2;
```

- Overview writes one segment per edge into that buffer.
- If packing would exceed segment capacity, stop emitting further edges and surface a diagnostics signal — never silent overwrite.
- Diagnostics:
  - `visibleEdges` = distinct edge ids materialized  
  - `visibleEdgeSegments` = segment instances drawn  
  - candidates / markers keep current meanings  

## Surfaces

- `examples/benchmark` + docs Explore playground: path select; toggle auto vs explicit demo controls.
- Docs: API reference + visual-language note; overview collapses curves; step deferred.

## Testing

- Path enum + control-point count validation.
- Auto control derivation is deterministic for fixed endpoints.
- Sample counts by path and LOD tier.
- Capacity formula uses `× 12`.
- Markers use end-segment tangents.
- Straight-only graphs match prior segment counts and draw-call baseline.

## Acceptance

- [ ] Public types documented with mapper examples
- [ ] Path kinds remain a single edge draw call
- [ ] Invalid values fail with actionable errors
- [ ] Laboratory / playground exposes path options
- [ ] Overview forces straight; detail restores path
- [ ] Off-screen edges do not consume segment instances
- [ ] 1k / 10k / 100k still runnable; document measured cost if material

## Out of scope

- Arbitrary Three materials / custom meshes per edge
- Unbounded HTML edges
- Full React Flow path parity on the dense path
