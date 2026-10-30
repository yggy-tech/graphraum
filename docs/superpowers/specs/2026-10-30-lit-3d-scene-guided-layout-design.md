# Lit 3D scene + guided layout: design spec

**Date:** 2026-10-30
**Status:** Approved for planning
**Issues:** [#164](https://github.com/yggy-tech/graphraum/issues/164), [#165](https://github.com/yggy-tech/graphraum/issues/165), [#166](https://github.com/yggy-tech/graphraum/issues/166), [#167](https://github.com/yggy-tech/graphraum/issues/167), [#168](https://github.com/yggy-tech/graphraum/issues/168), [#169](https://github.com/yggy-tech/graphraum/issues/169), [#170](https://github.com/yggy-tech/graphraum/issues/170)
**Prototype:** Claude Design project "Graphraum", files `3D Space v2.html` (look) and `3D Settings.html` (yggy menu, option A chosen)

---

## Problem

1. **Edges never pass in front of a node in 3D.** Edges draw before nodes with `depthTest: false` (`src/edge-rendering.ts`, `EDGE_RENDER_ORDER = -1`) and node billboards always cover them. An edge that runs in front of a node in space still disappears behind it, and arrowheads at the far side vanish.
2. **3D looks flat.** Nodes are camera-facing SDF discs without light, so depth only comes from perspective and size. Hosts that want a game-like scene (light, shadows between nodes, a starfield) have no way to get it.
3. **Clusters come only from topology.** `createForceSimulation` knows edges and an optional cluster index. Hosts that have node embeddings cannot use them to shape the layout ("similar things sit together") without writing their own simulation.

## Goals

1. Edges and nodes share one depth buffer in 3D, so an edge sits in front of or behind a node by its real position. This is useful in every style, including flat.
2. Opt-in shading styles `flat` (today), `lit` and `toon`, with a directional sun and optional real shadows that nodes cast onto each other.
3. An empty-space scene: optional depth haze and a starfield. No ground plane.
4. Direction cues beyond the triangle marker: tapered edges and an animated flow.
5. Bounded relation (predicate) labels on edges through the overlay.
6. Guided layout: anchor positions per node (from a projection of embeddings) as an extra force, next to the existing clusters and per-edge springs.
7. One small, discoverable API surface for all of it: a host should be able to turn the whole look on with a single call.

## Non-goals

- Ground planes, floor shadows, reflections, bloom. (Dominik: the graph floats in empty space.)
- Edges casting or receiving shadows. Edges stay hairline batches.
- Computing embeddings, kNN, UMAP/PCA or HDBSCAN inside graphraum. Those are host concerns; graphraum takes arrays.
- Per-node meshes or per-node materials. The dense path stays batched.
- Changes to 2D. Everything here is a no-op in 2D except edge labels and guided layout.

## Constraints

- **Draw calls.** The two-draw-call baseline (one node batch, one edge batch) holds for `flat`, `lit` and `toon` without shadows. Shadows add one depth pass for the node batch. Stars add one points draw. Each addition is reported in `getDiagnostics()` and only exists while enabled.
- **No hidden loops.** Flow animation and sun motion run a frame loop only while enabled and visible, like `setAutoOrbit`, and show up in diagnostics.
- **Backward compatible.** Every option defaults to today's behaviour. `edgeDepth` starts as opt-in; switching the 3D default is a separate, announced change.

## Approach

### A. Sphere impostors and shared depth

Nodes stay instanced billboards. In 3D with `edgeDepth: "scene"` or a lit style, the node fragment shader treats a `circle` node as a sphere impostor:

- normal from the billboard UV: `n = vec3(uv, sqrt(1 - dot(uv, uv)))` in view space;
- `gl_FragDepth` written from the sphere surface point, so depth is correct per pixel, not per quad;
- non-circle shapes get a domed normal from their SDF distance (a soft bevel) and the billboard plane depth.

Edges switch to `depthTest: true, depthWrite: false` and keep their existing boundary trim, now measured against the sphere silhouette. The old "clip behind its nodes" branch in the edge vertex shader is skipped in this mode. Markers draw with the same depth test, so an arrowhead behind a node is hidden by that node and visible otherwise.

### B. Shading styles

| Style | Node fragment | Uniforms |
| --- | --- | --- |
| `flat` | today's SDF fill and stroke | none new |
| `lit` | Lambert diffuse from the sun + hemisphere ambient, small specular, stroke as a rim outline | sun direction, sun colour, ambient sky/ground |
| `toon` | diffuse quantised to 3 bands, stroke always drawn as outline | same as `lit` |

Borders need no new API: `strokeWidth` / `strokeColor` (per node or via `defineVisuals`) already control them, and in `lit` / `toon` the stroke renders as a silhouette rim. Hosts turn borders off with `strokeWidth: 0`.

Dimming keeps blending colour towards the background, never transparency, so depth and shadows stay correct.

### C. Shadows

`shadows: true` (only with `lit` / `toon`, 3D) adds a depth pass that renders the node impostors from the sun into a depth texture (orthographic, fitted to the graph bounds, size `shadowMapSize`, default 2048). The node shader reconstructs the surface point, projects it into the light space and samples the map with PCF (4 to 9 taps). Nodes shade each other; there is nothing else to receive shadows.

### D. Space

- `haze`: linear fog towards the background colour on nodes and edges, from `near` to `far` as multiples of the graph radius.
- `stars`: one `Points` draw on a far shell (fixed pixel size, no depth write, does not move with pan, rotates with the camera). Count, colour and opacity are options. Only drawn when the background is a solid colour; hosts decide per theme (the yggy Lab shows stars in dark only).

### E. Direction cues on edges

Per-edge visual, packed into the existing edge attributes:

- `taper` (0..1): width at the target as a fraction of the width at the source. 0 means no taper.
- `flow` (number, units per second, 0 off): an animated dash pattern moving from source to target. Implemented as a time uniform plus the existing dash style, so it costs no extra draw.

The existing `marker: "triangle"` stays the arrowhead. Its look in 3D gets slimmer defaults (longer, narrower) to match the prototype.

### F. Edge labels (overlay tier)

Edge labels are host HTML in the overlay, bounded like node labels:

- `edgeLabelPolicy: "manual" | "focus" | "all"` with `maxEdgeLabels` (default 32, hard cap 128);
- `renderEdgeLabel(edge)`; default renders `presentation.title`;
- placed at the visual midpoint of the edge path, hidden when that point is behind a node (CPU ray against the bounded set's nearby spheres) or off-screen;
- `focus` shows the edges incident to selected and hovered nodes.

This keeps the Fidelity on demand rule: no per-edge HTML on the dense path.

### G. Guided layout

`ForceLayoutRequest` gains anchors:

```ts
anchors?: {
  /** nodeCount * dimensions values, same order as nodes. NaN skips a node. */
  positions: Float32Array;
  /** Pull towards the anchor, scaled by the step alpha. Number for all nodes or one value per node. */
  strength?: number | Float32Array;
};
```

and `ForceSettings.anchorStrength` (default 0.01, clamped 0..0.1). Anchor positions are normalised to the layout's own scale (the host passes any range; graphraum rescales to the expected graph radius), so a UMAP output in [-10, 10] and a PCA output in [-1, 1] behave the same.

Together with what exists today this covers the three ideas Dominik raised:

| Host computes | graphraum input |
| --- | --- |
| kNN over embeddings | extra layout edges in `edges` with weak `springStrengths` (already supported, layout edges need not be rendered) |
| UMAP or PCA to 2D/3D | `anchors.positions` |
| HDBSCAN (or DBSCAN) clusters | `clusters` (already supported) |

A docs recipe ("Guided layout") shows the full pipeline. No new dependency enters graphraum.

## Public API

One entry point for the scene, matching the `setDepthOfField` pattern (partial update, validated, animatable where it makes sense):

```ts
type GraphraumShading = "flat" | "lit" | "toon";

interface GraphraumSceneOptions {
  /** Default "flat". 3D only; 2D always renders flat. */
  shading?: GraphraumShading;
  /** "behind-nodes" (default, today) or "scene": edges and nodes share depth in 3D. */
  edgeDepth?: "behind-nodes" | "scene";
  /** Default false. Needs shading "lit" or "toon". */
  shadows?: boolean | { mapSize?: 1024 | 2048 | 4096; softness?: number };
  sun?: {
    /** Degrees around the vertical axis, default 220. */
    azimuth?: number;
    /** Degrees above the horizon, 10..85, default 55. */
    elevation?: number;
    color?: GraphraumColor;
    intensity?: number;
    /** Opt-in slow sweep; runs a frame loop while enabled and visible. */
    motion?: false | { degreesPerSecond?: number };
  };
  ambient?: { sky?: GraphraumColor; ground?: GraphraumColor; intensity?: number };
  haze?: false | { near?: number; far?: number };
  stars?: false | { count?: number; color?: GraphraumColor; opacity?: number };
}

// constructor
new Graphraum(container, { scene: { shading: "lit", edgeDepth: "scene", shadows: true } });

// later, partial updates merge
graph.setScene({ shading: "flat" });
graph.setScene({ sun: { azimuth: 90 } }, { animate: true });
graph.getScene(); // Readonly<ResolvedGraphraumSceneOptions>
```

Edge visual additions: `taper?: number`, `flow?: number`. Overlay additions: `edgeLabelPolicy`, `maxEdgeLabels`, `renderEdgeLabel`, `edgeLabelClassName`. Layout additions: `anchors`, `ForceSettings.anchorStrength`.

Presets for hosts that want one line:

```ts
import { graphraumScenes } from "@yggy-tech/graphraum";
graph.setScene(graphraumScenes.lit);   // lit + scene depth + shadows
graph.setScene(graphraumScenes.flat);  // flat + scene depth
graph.setScene(graphraumScenes.toon);
```

Validation: unknown keys and out-of-range numbers throw with the option path and the allowed range (`scene.sun.elevation must be 10..85, got 120`). `shadows: true` with `shading: "flat"` is not an error; it is stored and becomes active when the style changes, and `getDiagnostics().shadows` reports `"inactive"`.

Diagnostics additions: `shading`, `edgeDepth`, `shadows: "off" | "inactive" | "active" | "unsupported"`, `shadowMapSize`, `stars` (count drawn), `animatedEdges` (edges with flow in the last frame), `edgeLabels` (count shown).

## yggy consumer (for orientation, not part of this repo)

Graph Lab menu option A: Style (Flat / Lit / Toon) maps to `graphraumScenes.*`; Show keeps Colour by, Labels, Relation (`edgeLabelPolicy`), Direction (Off / Arrow = marker, Taper = `taper`, Flow = `flow`); folded groups Nodes (borders = strokeWidth), Edges, Light (`shadows`, `sun`), Space (`haze`, `stars`, dark theme only), Motion. Embedding projection and clustering run server-side and arrive as `anchors` and `clusters`.

## Delivery

One issue and PR per slice, each releasable on its own:

1. [#164](https://github.com/yggy-tech/graphraum/issues/164) Sphere impostors + `edgeDepth: "scene"` (fixes the reported edge problem on its own, also in flat).
2. [#165](https://github.com/yggy-tech/graphraum/issues/165) `shading` lit / toon + `sun` + `ambient`, `setScene` / `getScene` / presets.
3. [#166](https://github.com/yggy-tech/graphraum/issues/166) `shadows` depth pass.
4. [#167](https://github.com/yggy-tech/graphraum/issues/167) `haze` + `stars`.
5. [#168](https://github.com/yggy-tech/graphraum/issues/168) Edge `taper` + `flow`.
6. [#169](https://github.com/yggy-tech/graphraum/issues/169) Edge labels in the overlay.
7. [#170](https://github.com/yggy-tech/graphraum/issues/170) Guided layout `anchors` + docs recipe.

## Verification

- Unit tests: option validation and merging, anchor normalisation, taper/flow packing, edge label budget and occlusion helper, shadow camera fit.
- Browser checks (docs playground): edge in front of / behind a node at several camera angles, arrowhead behind a node hidden, shadows on neighbours while the sun moves, flat unchanged from today.
- Benchmark per slice at 10k and 100k nodes: frame time and draw calls for flat, lit, lit + shadows, compared to `main`. Shadows and stars must stay off the dense default.

## Open questions

1. Shadow map size and softness defaults at 100k nodes: measure before fixing.
2. Should `edgeDepth: "scene"` become the 3D default in the next major, or stay opt-in?
3. Toon outline from the stroke only, or also a screen-space edge pass for intersections? (Second costs a pass; start without.)
