# GPU Node Shape Catalog + Stroke + Axes — Design Spec

**Date:** 2026-08-08  
**Status:** Approved for planning  
**Issue:** [#80](https://github.com/yggy-tech/graphraum/issues/80) (shapes-first slice; edge paths deferred)  
**Related:** [#81](https://github.com/yggy-tech/graphraum/issues/81) rich HTML focus, [#82](https://github.com/yggy-tech/graphraum/issues/82) fidelity ADR, [#83](https://github.com/yggy-tech/graphraum/issues/83) NMS starmap research

---

## Problem

Node visuals are limited to `circle` | `square` | `diamond` with a single uniform `size` and no stroke. Product graphs (and NMS-inspired density) need a richer batched shape catalog and non-square footprints without leaving the one-draw-call node path.

## Goals

1. Add SDF shapes: `hexagon`, `triangle`, `pill`, `rounded` (keep existing three).
2. Optional stroke via SDF ring: `strokeWidth`, `strokeColor`.
3. Independent `width` / `height` axes (zero GPU cost — matrix scales already separate).
4. Preserve one node draw call; picking matches outer boundary (fill + stroke).
5. Document + laboratory controls.

## Non-goals

- Edge path kinds (`quadratic` / `step`) — later #80 follow-up or sibling issue.
- Icon atlas / arbitrary textures.
- NMS glow / bloom (#83).
- Rich HTML nodes (#81).
- Per-node custom shaders or materials.

## Approach

**SDF catalog + stroke attrs in the existing node shader (Approach A).**

Extend `instanceShape` codes. Add `instanceStrokeWidth` and `instanceStrokeColor`. Fill remains `instanceColor` / `setColorAt`. Stroke is a fragment ring between outer and inner SDF distances. `strokeWidth: 0` preserves today’s fill-only look.

Non-uniform axes: resolve `width` / `height` and call `matrix.makeScale(width, height, depth)` — the vertex shader already uses independent `scaleX` / `scaleY`.

## Public contract

```ts
type GraphraumNodeShape =
  | "circle"
  | "square"
  | "diamond"
  | "hexagon"
  | "triangle"
  | "pill"
  | "rounded";

interface GraphraumNodeVisual {
  color?: GraphraumColor;
  shape?: GraphraumNodeShape;
  /** Uniform scale shorthand when width/height omitted. */
  size?: number;
  width?: number;
  height?: number;
  /** Screen-space stroke in px; default 0 (no stroke). */
  strokeWidth?: number;
  strokeColor?: GraphraumColor;
}
```

Same optional fields on node snapshots and `GraphraumNodeUpdate`.

**Axis resolve:** `width ?? size ?? defaultSize`, `height ?? size ?? defaultSize` (default size remains `4` today).

**Stroke resolve:** if `strokeWidth > 0` and `strokeColor` omitted → `theme.nodeStroke` (new theme field; default a light porcelain/green suitable for Ink Black canvases, e.g. `#fcfffc` or a muted outline — pick in implementation and document).

**Validation (compile / update):**

- `size` / `width` / `height` positive finite when present
- `strokeWidth` finite and ≥ 0
- unknown `shape` rejected with node id

## Renderer

| Piece | Change |
|-------|--------|
| `node-shapes.ts` | Union, encode 0–6, `containsNodePoint` per shape; optional stroke inflation for pick in caller |
| `node-rendering.ts` | SDF branches + stroke ring; attrs `instanceStrokeWidth`, `instanceStrokeColor` |
| `graphraum.ts` | Write stroke attrs; `makeScale(width, height, …)`; pick uses outer bounds with width/height |
| `compile-graph.ts` | Validate new visual fields |
| Theme | `nodeStroke` default |

Interaction states continue to tint **fill** only.

## Picking

- Normalize pointer offset by `width` / `height` (not a single radius).
- Hit test outer SDF (stroke expands the hit region when `strokeWidth > 0`).
- Spatial grid cell occupancy must use max(width, height) (+ stroke) for radius.

## LOD

No change to density LOD policy. New shapes participate equally; overview does not force shape collapse in this slice (YAGNI — can force `circle` later if measured).

## Testing

- Encode / assert / `containsNodePoint` for all seven shapes
- Stroke widens pick; zero stroke matches fill boundary
- Axis resolve: `size` alone; `width`/`height` override; compile rejects non-positive axes
- Diagnostics still one node draw call (architectural; no WebGL harness required)
- Docs + lab controls for shape, stroke, width/height

## Acceptance

- [ ] Seven shapes documented with mapper examples
- [ ] Stroke and axes work in 2D and 3D
- [ ] Invalid visuals fail with actionable errors
- [ ] One node draw call preserved
- [ ] Laboratory exposes shape / stroke / width / height
- [ ] Changelog entry

## Delivery

Single PR against #80 titled around GPU node shape catalog. Comment on #80 that edge paths remain open.
