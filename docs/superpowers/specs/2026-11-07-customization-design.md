# Customization: styles, chips, host rendering, node style variants, shader hook

**Date:** 2026-11-07
**Status:** Approved for planning (direction approved by the maintainer; API sketches are proposals)
**Issues:** [#203](https://github.com/yggy-tech/graphraum/issues/203), [#204](https://github.com/yggy-tech/graphraum/issues/204), [#205](https://github.com/yggy-tech/graphraum/issues/205), [#206](https://github.com/yggy-tech/graphraum/issues/206), [#207](https://github.com/yggy-tech/graphraum/issues/207)

---

## Problem

graphraum looks like yggy. The default theme is yggy's green palette, the node stroke, state colours and edge defaults are yggy's, and everything beyond colours is hard-coded in shaders:

1. **Only colours are configurable.** `GraphraumTheme` holds 14 colour and opacity values. Stroke width, hover/selection/focus treatment, dimming, edge dash and marker defaults, and label look cannot be changed without forking.
2. **Labels are the host's job and unstyled.** The overlay creates no label look of its own. A host that wants labels like chips, a font family, a background, has to build every element and keep it in sync.
3. **Pill and rounded nodes cannot hold text.** `pill` and `rounded` exist, but a node has no text, and the shader measures the pill caps in unit space, so a wide pill gets elliptical caps.
4. **Rich HTML is capped for focus only.** `renderRichNode` is limited to 24 focused cards (`maxRichNodes`); it cannot take over when the user zooms in on a few dozen nodes.
5. **Per-node styling is per-node data.** Restyling "all nodes of kind X" means rewriting every instance. There is no named style.
6. **No escape hatch.** A host that needs a look the style contract cannot express has no way to change the node shader.

## Goals

1. Other projects can adopt graphraum without looking like yggy. Defaults are neutral; yggy keeps its look as its own preset.
2. A full style contract (not just colours), applied at zero render cost: uniforms and CSS only.
3. Chips: nodes that are as wide as their text, with the text and an optional icon drawn on the GPU in the same instanced node pass.
4. A zoom-based switch to host DOM for the few nodes large enough on screen to read as cards.
5. Named node styles that restyle thousands of nodes with one write.
6. A bounded GLSL hook, only if goals 1 to 5 leave real gaps.

## Non-goals

- A general CSS-in-JS or theming engine. A style is plain data.
- Per-node meshes, per-node materials or per-node DOM in the dense path.
- Rich text layout on the GPU (wrapping, bidi, shaping of complex scripts). Chips are one line.
- Changing layout, graph semantics, accessibility trees or product actions. Those stay application concerns.

## Constraints (hard gates for every slice)

- **Two draw calls.** One node batch, one edge batch. Glow halos keep their existing opt-in extra draw. None of the five approaches adds a draw call; `getDiagnostics().gpuDrawCalls` is asserted in browser tests.
- **No per-node objects in the hot path.** Everything is typed-array attributes, uniforms or one small data texture. No per-node closures, strings or allocations per frame.
- **Rendering exactly as performant as today.** With no new feature enabled, the compiled node program, the attributes written per node and the per-frame work are the same as on `main`. With a feature enabled, the cost is stated per approach and measured.
- **Bundle budget.** The main entry gzip budget is 64.5 KiB (`scripts/check-bundle-size.ts`, 66 000 bytes); `main` measures 64.0 KiB, so the headroom is about 0.5 KiB. Optional features go into subpath entries (`./styles`, `./text`, `./shader`, next to the existing `./diagnostics`). Any slice that grows the main entry must pay for itself by moving code out of it.
- **No snapshot tests.** Shader and draw-order changes get a `*.browser.test.ts` in real WebGL2 asserting pixels and diagnostics.

## Existing surface this builds on

| Area | Today | File |
| --- | --- | --- |
| Colours | `GraphraumTheme`, presets `dark` and `light`, `Partial` override | `src/theme.ts`, `src/types.ts` |
| Node attributes | `instanceColor`, `instanceShape`, `instanceStrokeWidth`, `instanceStrokeColor`, plus `instanceMatrix` (size via x/y scale) | `src/node-rendering.ts` |
| Node states | Applied by writing the state colour into `instanceColor` on the CPU | `src/graphraum.ts` |
| Shapes | 7 SDF shapes in one fragment shader; `node-shapes.ts` mirrors them for picking | `src/node-shapes.ts` |
| Shading | `lit`/`toon` by shader define, `graphraumScenes` presets | `src/scene.ts` |
| Overlay | `renderLabel`, `renderToolbar`, `renderRichNode`, budgets (`maxLabels` 50, `maxRichNodes` 24) | `src/overlay.ts`, `src/overlay-budget.ts` |
| Subpath entries | `.` and `./diagnostics`, built by tsdown | `tsdown.config.ts`, `package.json` |

## Delivery order and why

1. Neutral defaults plus a style preset object: the contract everything else hangs off. Zero render cost.
2. Chips on the GPU: the largest user-visible gap and the riskiest, so it gets a measured prototype before commitment.
3. Zoom-based host DOM rendering: independent of 2 in code, but 2 decides whether it is needed at the zoom levels chips cover.
4. Node style variants: reuses the per-node state attribute and the style table plumbing from 1 and the glyph tint from 2.
5. Custom shader hook: last, only if 1, 2 and 4 leave gaps.

---

## 1. Neutral defaults plus a style preset object

### Problem

See problems 1 and 2. Colours are the only contract, the default is yggy's palette, and the overlay has no look.

### Public API sketch

`GraphraumTheme` stays exactly as it is (it becomes the `theme` member of a style) so existing `theme` options keep working.

```ts
/** Everything about how a graph looks. Plain data; merge with `defineGraphraumStyle`. */
export interface GraphraumStyle {
	/** Colours and opacities. The existing contract, unchanged. */
	theme: GraphraumTheme;
	node: {
		/** World-unit stroke width for nodes without their own `strokeWidth`. Default 0. */
		strokeWidth: number;
		/** Fill used by `dimmed` is `theme.dimmedNode`; this is how far to blend towards it, 0..1. */
		dimBlend: number;
	};
	/** Ring drawn outside the shape for a node state. `width` is a fraction of the node's half-extent. */
	states: {
		hovered: GraphraumStateTreatment;
		focused: GraphraumStateTreatment;
		selected: GraphraumStateTreatment;
	};
	edge: {
		/** Defaults for edges without their own value. */
		width: number;
		opacity: number;
		style: GraphraumEdgeStyle;
		/** Dash and gap in multiples of edge width, used by `dashed` and `dotted`. */
		dash: { dashed: readonly [number, number]; dotted: readonly [number, number] };
		marker: GraphraumEdgeMarker;
		markerSize: number;
	};
	label: GraphraumLabelStyle;
}

export interface GraphraumStateTreatment {
	/** `fill` recolours the node (today). `halo` draws a ring outside it. `both` does both. */
	mode: "fill" | "halo" | "both";
	color?: GraphraumColor;
	/** Ring width as a fraction of the node half-extent, 0 to 0.5. Default 0.18. */
	haloWidth?: number;
	/** Ring opacity, 0..1. Default 0.9. */
	haloOpacity?: number;
}

export interface GraphraumLabelStyle {
	/** Applied as CSS custom properties on the overlay root. Any CSS value. */
	fontFamily: string;
	fontSize: string;
	fontWeight: string;
	color: string;
	background: string;
	borderColor: string;
	borderRadius: string;
	padding: string;
}

/** Presets. `neutral` is the default. Others live in `@yggy-tech/graphraum/styles`. */
export const graphraumStyles: {
	neutral: GraphraumStyle;
};

// "@yggy-tech/graphraum/styles"
export const graphraumStylePresets: {
	neutral: GraphraumStyle;
	blueprint: GraphraumStyle;
	/** Exactly today's look: yggy dark. Migration target for current hosts. */
	classicDark: GraphraumStyle;
	classicLight: GraphraumStyle;
};

export function defineGraphraumStyle(base: GraphraumStyle, overrides: DeepPartial<GraphraumStyle>): GraphraumStyle;

interface GraphraumOptions {
	/** A style, or a partial merged onto `neutral`. Default `graphraumStyles.neutral`. */
	style?: DeepPartial<GraphraumStyle>;
	/** Kept: `"dark"` | `"light"` | `Partial<GraphraumTheme>`. Shorthand for `style.theme`. */
	theme?: Partial<GraphraumTheme> | GraphraumThemeName;
}
// Graphraum#setStyle(style: DeepPartial<GraphraumStyle>): void   // merge, no recompile, no re-fit
```

`graphraumStyles` in the main entry exposes only `neutral`, because the main entry has no room for more. `blueprint` and the `classic*` presets live in `./styles` as plain objects. Precedence, highest first: per-node or per-edge value, `visuals` mapper, `style`, `theme` shorthand, neutral default.

Neutral defaults: grey nodes, `background: null` (transparent, so the host page shows through), no stroke, `selected` and `focused` as a halo, label colours `inherit`/`transparent` so they follow the host's CSS. Yggy imports `classicDark` and spreads its own overrides to keep its look as its own preset, in its own repository.

CSS custom properties set on the overlay root by `setStyle` and the constructor:

```
--graphraum-label-font, --graphraum-label-size, --graphraum-label-weight,
--graphraum-label-fg, --graphraum-label-bg, --graphraum-label-border,
--graphraum-label-radius, --graphraum-label-padding
```

A host may also set them in its own CSS; the overlay only writes the ones the style provides, via `style.setProperty` (CSSOM, so no CSP `style-src` relaxation). A new default label renderer, used when `renderLabel` is omitted, builds a `<span>` whose inline styles are `var(--graphraum-label-*)` references. `renderLabel` stays for full control.

### How it keeps performance

| Cost | Where | Amount |
| --- | --- | --- |
| Per frame | Uniform upload for halo width, opacity and colours (3 vec4) | negligible, same upload path as the sun uniforms |
| Per node | One new float attribute `instanceState` (0 none, 1 hovered, 2 focused, 3 selected) written when the state set changes; colour writes for state tint are unchanged | 4 bytes per node, written only for nodes whose state changes |
| Per draw | None. Halo and dimming are inside the node fragment shader | no new draw |
| Halo geometry | The node quad grows by `haloPad` (a uniform, 0 when no state uses a halo), so the halo has room outside the shape. Fragments outside shape and halo still `discard` | `haloPad = 0` keeps quad size, vertex output and overdraw identical to today |

The halo code sits behind a shader define (`GRAPHRAUM_STATE_HALO`) that is on only while some state uses `halo` or `both`, so a style without halos compiles the same program as today. The shape SDF is evaluated on the unpadded coordinate (`nodePoint` rescaled by `1 + haloPad`), so picking, stroke and the sphere impostor radius are unchanged. Halo rings are not pickable (picking stays on the shape). Dimming keeps blending colour towards the background and never uses transparency, as in the lit-scene spec.

### Bundle impact and entry

Main entry: the style resolver, the halo branch in the node shader, label CSS-variable writer and the neutral preset. Estimated +0.6 KiB gzip, which exceeds the 0.5 KiB headroom. Offset it by moving the `light` theme preset object and its string resolution into `./styles` (resolved lazily only when `theme: "light"` is passed through `defineGraphraumStyle`), or raise the budget in the same PR with the measured number and a reason, as `check-bundle-size.ts` already requires. Preferred: offset first, raise only if the offset is not enough. `./styles`: the `blueprint` and `classic*` presets, under 1 KiB gzip.

### Interaction with existing features

- **Shapes:** halo follows the SDF of every shape; the ring is `distanceToEdge` offset outward.
- **Shading lit/toon:** halo is unlit, like the stroke, so it reads as a rim.
- **Depth of field:** unchanged; it is a post pass over the final image.
- **Overlay budgets:** unchanged; CSS variables do not change counts. The new default label renderer still obeys `maxLabels`.
- **Picking:** unchanged (shape only).
- **Edge endpoint attach:** unchanged; it uses the unpadded shape.
- **2D/3D:** same shader path; with `edgeDepth: "scene"` the padded quad uses the unpadded sphere radius for `gl_FragDepth`.
- **Glow:** `glow` stays its own opt-in draw; a halo and a glow can both be on.

### Tests and benchmark gates

- Unit: style resolution and merge order, validation errors (unknown keys, out-of-range `haloWidth`, bad colours), CSS variable names written, `defineGraphraumStyle` immutability.
- Browser (`graphraum.style.browser.test.ts`, real WebGL2): pixel probes on a single node at a known screen position: fill colour at the centre, stroke colour at the stroke ring, halo colour at `radius * (1 + haloWidth/2)` for selected, background colour beyond the halo; `dimBlend` moves the probe colour towards the dimmed colour by the expected fraction (within a tolerance). Assert `gpuDrawCalls === 2` with halos on.
- Migration pixel test: render the same fixture with `theme: "dark"` on the old path and `style: classicDark` and compare probe pixels at nodes, edges and background; they must match within 1/255 per channel.
- Benchmark gate: docs benchmark at 10k and 50k nodes, 2D and 3D, pixel ratio 1 and 2, on the same browser as the baseline. `cpuFrameMilliseconds` and `gpuFrameMilliseconds` within 3 percent of `main` with halos off, and within 10 percent with all three halos on. Report fixture, browser, pixel ratio and the full result.
- Bundle gate: `check-bundle-size.ts` passes; `./styles` gets its own budget row.

### Migration

The default style becomes `neutral`, which changes what a host sees when it passes no theme. That is a breaking change: PR title carries `!`, `etc/graphraum.api.md` is updated and the changelog says it plainly. Hosts keep their look with one line:

```ts
import { graphraumStylePresets } from "@yggy-tech/graphraum/styles";
new Graphraum(container, { style: graphraumStylePresets.classicDark });
```

`theme: "dark"` and `theme: "light"` keep working and keep today's colours. A first release ships `style` and the presets with the default unchanged; a following, announced release flips the default (see open questions).

### Open questions

1. Flip the default in the same release as the preset, or one release later behind a deprecation notice in `getDiagnostics()`? Recommendation: ship presets first, flip the default in the next minor with `!`.
2. Presets as flat names (`classicDark`, `classicLight`) or `{ light, dark }` pairs with a `colorScheme` option? Flat names are simpler to type and tree-shake; pairs fit host dark-mode switches better.
3. Should `neutral` be transparent-background by default? It looks right on any host page but removes the guaranteed contrast of an opaque canvas.
4. Is a halo mode worth a shader branch for hosts that never use it? If the measured main entry cost is too high, halos could be `./styles`-only via a shader define.

---

## 2. Chips on the GPU

### Problem

See problem 3. Hosts want node-as-chip: a pill or rounded rectangle as wide as its label, with the text and optionally an icon, for thousands of nodes. DOM labels are capped by `maxLabels` and do not scale. The pill SDF also assumes a square quad: with `width != height` the caps become elliptical.

### Public API sketch

Main entry (small hook, types only for the chip fields):

```ts
interface GraphraumNodeVisual {
	/** One line of text drawn inside the node. Needs a text provider (see `options.text`). */
	text?: string;
	textColor?: GraphraumColor;
	/** Index into the provider's icon atlas. */
	iconIndex?: number;
}

interface GraphraumOptions {
	/** Created by `createGraphraumText` from `@yggy-tech/graphraum/text`. */
	text?: GraphraumTextProvider;
}

/** Opaque to the core: it only attaches the pieces below. */
export interface GraphraumTextProvider {
	readonly shaderChunk: string;
	readonly textures: Readonly<Record<string, Texture>>;
	/** Writes per-node glyph ranges and returns the node width in world units for a text and height. */
	layout(text: string, nodeHeight: number): { width: number; glyphStart: number; glyphCount: number };
}
```

New subpath entry `@yggy-tech/graphraum/text`:

```ts
export function createGraphraumText(options: {
	atlas: GraphraumGlyphAtlas;
	icons?: GraphraumIconAtlas;
	/** Max glyphs per chip. Longer text is cut with an ellipsis glyph. Default 24. */
	maxGlyphs?: number;
	/** Screen height in CSS pixels below which a chip draws no text. Default 7. */
	minTextPixels?: number;
	padding?: number; // in glyph heights, default 0.5
}): GraphraumTextProvider;

/** Loads a prebuilt MSDF atlas (PNG plus BMFont-style JSON, as written by msdf-atlas-gen). */
export function loadGlyphAtlas(urls: { image: string; metrics: string }): Promise<GraphraumGlyphAtlas>;

/** Browser-side fallback for Latin sets: single-channel SDF through OffscreenCanvas. */
export function generateGlyphAtlas(options: { font: FontFace | string; charset: string; size?: number }): Promise<GraphraumGlyphAtlas>;

export function loadIconAtlas(urls: { image: string; grid: readonly [number, number] }): Promise<GraphraumIconAtlas>;
```

Chip example:

```ts
const text = createGraphraumText({ atlas: await loadGlyphAtlas({ image, metrics }) });
const g = new Graphraum(el, { text, style: graphraumStyles.neutral });
g.setData({ nodes: [{ id: "a", position: { x: 0, y: 0 }, shape: "pill", height: 8, text: "Invoice #4711" }], edges: [] });
// width is derived from the text when `width` is omitted
```

When a node has `text` and no `width`, the core asks `provider.layout` and uses its width for the node's x scale. Width is world-space, so the chip scales with zoom like any node.

### How it keeps performance

**Aspect ratio (free).** `nodeAspect = scaleX / scaleY` is already encoded in `instanceMatrix`. The vertex shader forwards it as a varying and the fragment shader evaluates `pill` and `rounded` in aspect-corrected space (cap and corner radius defined by the height, not the width). No new attribute, no extra per-node data. Stroke width is converted to uv per axis the same way. For `aspect == 1` the result is identical to today; a pixel probe test proves it.

**Text in the same pass.** Per node, two new attributes: `instanceGlyphStart` and `instanceGlyphCount` (one vec2 or two floats), plus the icon index and text colour (reusing the style table from slice 4 once it exists; until then `instanceTextColor` vec3). The glyph table is one `RGBA32F` data texture (position, advance, atlas uv per glyph, 2 texels), written when text changes. The fragment shader runs only for fragments inside the chip with `glyphCount > 0` and enough screen height:

1. map the fragment to text space (x along the chip, y in glyph heights);
2. find the glyph covering x: a loop over at most `maxGlyphs` table fetches with early exit, since glyphs are monotonic in x (a binary search over the range is the planned replacement if the prototype shows the loop is the cost);
3. one MSDF atlas sample, `median(r,g,b)`, `smoothstep` with `fwidth` for antialiasing, mixed over the fill.

Honest accounting: "one extra texture lookup" is true for the atlas; the glyph search adds up to `maxGlyphs` small fetches of a cached table in the worst case. That is why this slice starts with a prototype and a measurement, not a commitment (see gates). Fragments with `glyphCount == 0` or below `minTextPixels` take a uniform branch that skips all of it, so graphs without chips pay nothing but the branch.

| Cost | Amount |
| --- | --- |
| Per frame | Two texture bindings (atlas, glyph table); no CPU work |
| Per node | 12 to 16 bytes of attributes; glyph table rows only when the text changes |
| Per draw | None added. Same instanced node draw |

### Bundle impact and entry

Main entry: the chip fields on the types, the aspect-corrected pill and rounded SDF, the provider attach hook (a define for the chunk and two uniforms) and the layout call. Target at most +0.3 KiB gzip, paid for by the budget offset from slice 1. Everything else (glyph metrics parsing, SDF generation, layout, ellipsis, icon grid) ships in `@yggy-tech/graphraum/text`, with its own budget row (target under 6 KiB gzip without any atlas data). Atlas images are host assets and are not bundled.

### Interaction with existing features

- **Shapes:** text applies to `pill`, `rounded` and `square`. Other shapes ignore `text` and log one actionable diagnostic. The text box is the inscribed rectangle.
- **Shading lit/toon:** glyphs are drawn after shading, unlit, so text stays readable; the fill still shades.
- **Depth of field:** blurs chips with the rest of the frame; text blur is expected.
- **Overlay budgets:** GPU text is not an overlay entry, so `maxLabels` does not apply. Below `minTextPixels` the host can still show DOM labels for the focus set.
- **Picking:** unchanged; the hit shape is the chip's box (width and height already feed `containsNodePoint` via the node axes). `node-shapes.ts` must evaluate `pill` and `rounded` with the same aspect correction as the shader; a unit test compares CPU and GPU coverage on a grid.
- **Edge endpoint attach:** boundary trim uses the aspect-corrected shape, so edges meet the chip's real boundary (a wider ellipse-free pill). Needs the same change in `edge-endpoint-attach.ts`.
- **2D/3D:** billboards face the camera in 3D, so text is always upright. With sphere impostors the circle shape has no text.

### Tests and benchmark gates

- Unit: layout widths for known strings against atlas metrics, ellipsis cut, missing glyph handling, `containsNodePoint` with aspect for `pill` and `rounded` (also against the shader through the browser test), endpoint attach on a wide pill.
- Browser: pixel probes on a chip at known positions (fill at the padding, text-colour at a glyph stem centre of a known glyph, background between letters); aspect `1` renders the same probes as before; `gpuDrawCalls === 2` with chips on; wide pill cap is circular (probe on the cap arc).
- **Prototype gate (first PR, no public API):** a branch with the shader and a synthetic glyph table, measured on 10k and 50k chips of 12 and 24 glyphs at pixel ratio 1 and 2, 2D and 3D, headless Chromium with SwiftShader and a real GPU run. Pass criteria: GPU frame time within 15 percent of the same fixture with text off, at 24 glyphs, and no change with text off. If it fails, fall back to the alternatives in the open questions before any public API lands.
- Bundle gate: main within budget, `./text` row added.

### Migration

Purely additive. Nodes without `text` render as today. `pill` and `rounded` nodes with unequal `width` and `height` change shape (circular caps instead of elliptical); that is a bug fix and called out in the changelog.

### Open questions

1. Prebuilt MSDF atlas only (smallest bundle, best quality) or also in-browser generation (single-channel SDF, convenient, softer corners)? Recommendation: ship `loadGlyphAtlas` first, `generateGlyphAtlas` behind the prototype.
2. Per-fragment glyph search versus a per-node baked row texture (fixed 32 columns, one fetch, more memory). Decide from the prototype numbers.
3. Characters outside the atlas (CJK, emoji): tofu, or fall back to the DOM label for that node? Recommendation: tofu plus a diagnostic counter; DOM fallback is slice 3.
4. Should text colour be a per-node attribute or come from the style table of slice 4? Recommendation: attribute now, move to the table when slice 4 lands.
5. Vertical text alignment and multi-line: out of scope for v1; confirm.

---

## 3. Zoom-based switch to host DOM rendering

### Problem

See problem 4. `renderRichNode` is limited to selected or hovered nodes and a hard cap of 24 that throws on manual use. When the user zooms into a region, a few dozen nodes become large on screen and the host wants its own cards (with buttons, images, accessible markup) instead of GPU shapes, without adding per-node DOM to the dense path.

### Public API sketch

```ts
interface GraphraumOverlayOptions {
	/**
	 * Replaces the node by host DOM once it is big enough on screen. Chosen in screen space on
	 * every view change; at most `maxVisible` nodes at a time.
	 */
	richNodesByZoom?: {
		/** Minimum on-screen node size in CSS pixels (the larger side) to qualify. Default 96. */
		minScreenSize?: number;
		/** Hysteresis: a card stays until the node drops below `minScreenSize * (1 - hysteresis)`. Default 0.2. */
		hysteresis?: number;
		/** Budget of simultaneous cards. Default 60. Hard ceiling 120. */
		maxVisible?: number;
		/** Ranking when more nodes qualify than the budget: largest first, or closest to the view centre. Default `"size"`. */
		priority?: "size" | "center";
		/** How the card follows the node: `fit` sets the CSS vars below, `none` only positions. Default `fit`. */
		scale?: "fit" | "none";
		/** Cards take pointer events. Default true; `false` leaves picking to the GPU node. */
		interactive?: boolean;
	};
	renderRichNode?: (node: GraphraumOverlayNode & { screenSize: number }) => HTMLElement | null;
}
```

Each card gets `--graphraum-node-screen-size` (px) and, with `scale: "fit"`, a `transform` that centres it on the node and scales it so its authored size maps to the node's on-screen size. `autoRichNodes` (focus cards) keeps working and uses its own budget; the two sets are merged by id and share the existing `maxRichNodes` ceiling only for focus cards.

### How it keeps performance

- **Per view change:** one pass over the already-computed visible node candidates (the same list the label budget uses), filtered by on-screen size, a partial selection of the top `maxVisible` (nth-element, not a full sort), then a diff against the current card set. Cost is O(visible candidates), no allocation per node beyond the output ids.
- **Per card:** `render` is called once when a node enters the set and again only when its presentation object changes (the existing check in `updateEntry`). Transforms are batched: all reads first, then all writes in one animation frame, `contain: layout paint` on each card.
- **GPU:** the node stays in the instanced pass underneath so picking, edge ends and depth keep working. `fade` hiding of the GPU node under a card is optional (see open questions) and, if used, is a per-node colour write, not a draw change.
- **Budget:** 60 cards is the default because transform updates for 60 composited elements stay within a frame at 60 fps on mid-range laptops; the gate below verifies this and lets the number be changed with evidence.

### Bundle impact and entry

Main entry; the overlay is already there. Target at most +0.4 KiB gzip (selection with hysteresis, one CSS variable, scale transform). If it does not fit, the screen-space selector moves into a lazily imported chunk of the overlay.

### Interaction with existing features

- **Shapes:** the card replaces the node visually; use `node.shape` only for the on-screen size (larger of width and height).
- **Shading lit/toon, depth of field:** the GPU node is shaded and blurred as usual; cards are DOM and are not blurred. In 3D with depth of field on, cards for blurred nodes would look inconsistent; default is to exclude nodes whose blur radius exceeds 2 px.
- **Overlay budgets:** a separate budget (`maxVisible`); `maxLabels` is unaffected. Labels for a node with a card are suppressed.
- **Picking:** GPU picking remains; with `interactive: true` the card handles its own pointer events and the overlay emits a `graphraum:node-activate`-style callback so the host does not have to re-implement selection (decision in the issue).
- **Edge endpoint attach:** unchanged, edges still end at the GPU node boundary under the card.
- **2D/3D:** 2D is exact. In 3D cards are ordered by view depth with `z-index` and scale with perspective, but occlusion between cards and nodes is not exact; the default is to enable it for `mode: "2d"` and document the 3D limit.

### Tests and benchmark gates

- Unit (`overlay-budget.test.ts` style): selection by size with hysteresis, budget cut, priority modes, stable ids across small zoom changes (no flicker).
- Browser: zoom a fixture so N nodes exceed the threshold; assert card count equals `min(N, maxVisible)`, cards are positioned within 1 px of the node's screen position, the GPU node is still present (pixel probe under a transparent card), and `gpuDrawCalls === 2`.
- Benchmark gate: pan and zoom with 60 cards over a 10k-node fixture; main-thread frame time from the overlay update under 2 ms at p95 in headless Chromium, and no layout thrash (a single read phase, a single write phase, asserted by counting `getBoundingClientRect`-class reads in a test double).
- Bundle gate: main within budget.

### Migration

Additive. `renderRichNode`, `autoRichNodes` and `maxRichNodes` keep their meaning. Hosts opt in with `richNodesByZoom`.

### Open questions

1. Should the GPU node be hidden under a card (avoids double edges and halo, costs a colour write) or left visible (card must be opaque)? Recommendation: leave visible, require opaque cards.
2. Event model for interactive cards: callback on the overlay, or let the host handle events and call `selectNode`? Recommendation: host handles, overlay stays dumb.
3. Default threshold 96 px and budget 60: confirm on real hardware before documenting them as defaults.
4. 3D occlusion: is "2D only for v1" acceptable?

---

## 4. Node style variants

### Problem

See problem 5. A host with 20 node kinds writes colour, stroke and text colour into every instance, and a theme switch or "highlight all nodes of kind X" rewrites all of them on the CPU.

### Public API sketch

```ts
export interface GraphraumNodeStyle {
	color?: GraphraumColor;
	strokeColor?: GraphraumColor;
	strokeWidth?: number;
	textColor?: GraphraumColor; // with ./text
	glow?: number;
	/** Per-state overrides, replacing the global state treatment from `style.states` for this style. */
	states?: Partial<Record<"hovered" | "focused" | "selected" | "dimmed", GraphraumNodeStyleState>>;
}
export interface GraphraumNodeStyleState { color?: GraphraumColor; strokeColor?: GraphraumColor; haloColor?: GraphraumColor; }

interface Graphraum {
	/** Defines or replaces a style. Replacing restyles every node that uses it with one table write. */
	registerNodeStyle(name: string, style: GraphraumNodeStyle): void;
	unregisterNodeStyle(name: string): void; // nodes using it fall back to the theme defaults
}
interface GraphraumNodeVisual { style?: string }   // also on GraphraumNodeGeometry and GraphraumNodeUpdate
```

Resolution order, highest first: per-node `color`/`strokeColor`/`strokeWidth`, then the node's named style, then `style.node` defaults, then the theme. Shape and size are not style fields because they drive CPU picking, edge attach and the instance matrix; they stay per node. A host that wants kinds with different shapes sets `shape` through its `visuals` mapper as today.

### How it keeps performance

- **Per node:** one new float attribute `instanceStyle` (style index plus two override bits: has own colour, has own stroke). Setting a node's style is one float write; a node with its own colour keeps writing `instanceColor` as now.
- **Style table:** a `RGBA16F` data texture, one row per style times five states (normal, hovered, focused, selected, dimmed), two texels per row (fill+strokeWidth, stroke+halo). Capacity 64 styles, so 640 rows. It is fetched in the vertex shader with `texelFetch` using `instanceStyle * 5 + instanceState` and passed on as the existing `nodeColor`/`nodeStrokeColor` varyings. Per-vertex, not per-fragment: 4 fetches per node, the fragment shader is unchanged.
- **Restyle:** `registerNodeStyle` on an existing name rewrites 10 texels. Cost is independent of the number of nodes using it. This replaces the CPU rewrite for state tints too once complete: a hovered node changes `instanceState`, not its colour.
- **Draw calls:** none added. A texture binding is added only when at least one style is registered; otherwise the define is off and the program is the one from slice 1.

### Bundle impact and entry

Main entry (the table is core plumbing and slice 1 already carries `instanceState`). Target at most +0.5 KiB gzip. If it does not fit the budget after slice 1 and 2 offsets, the registration API moves to a `./styles` extension that attaches the table; decided with the measured numbers.

### Interaction with existing features

- **Shapes and picking:** unchanged; styles do not touch geometry.
- **Shading lit/toon:** the style colour is the base colour that is lit, exactly as `instanceColor` is today.
- **Depth of field:** unchanged.
- **Overlay budgets:** unchanged. Labels can read the style name from the presentation if the host wants to key off it.
- **Edge endpoint attach:** unchanged.
- **Glow:** `glow` in a style feeds the existing glow instances; changing it re-selects glow nodes (bounded by the 256 cap), the one CPU effect of a restyle.
- **2D/3D:** same path.
- **Chips:** `textColor` and icon tint come from the table, which retires the per-node text colour attribute from slice 2.

### Tests and benchmark gates

- Unit: resolution order, override bits, unknown style name error, capacity error at 65 styles, re-register semantics, unregister fallback.
- Browser: 1 000 nodes in two styles; restyle one style and probe pixels on nodes of both groups (only one group changes); hover a node and probe the style's `hovered` colour; `gpuDrawCalls === 2`; a node with its own `color` keeps it through a restyle.
- Benchmark gate: restyle 50k nodes (one style) measured at under 0.1 ms CPU and no extra GPU frame time beyond 3 percent against slice 1; per-node style assignment on `setData` of 50k nodes within 5 percent of today's `setData` time.
- Bundle gate as above.

### Migration

Additive. Nodes without `style` render as before. Hosts using `visuals.node` can return `{ visual: { style: "kind-a" } }`.

### Open questions

1. Texture or uniform array for the table? A uniform array is simpler but 640 vec4 exceeds the portable fragment uniform limit; a vertex-only table of 32 styles would fit. Recommendation: texture, 64 styles.
2. Do styles also cover edges? Recommendation: not in v1; edges already carry `color`, `width`, `style` per edge and the dense case is nodes.
3. Should `shape` in a style be allowed, with a CPU rewrite of the instance matrix and shape only for the nodes of that style on restyle? It keeps the hot path clean (no frame cost) but makes `registerNodeStyle` O(n of that style).

---

## 5. Custom shader hook

Only built if slices 1, 2 and 4 leave concrete gaps. Candidates to check against real hosts first: gradients and patterns in the fill, animated pulses, per-node SDF decorations. Many of these may be better as style fields.

### Problem

A host needs a node look no style field expresses, and forking the shader is the only option.

### Public API sketch

```ts
// "@yggy-tech/graphraum/shader"
export interface GraphraumNodeShader {
	/**
	 * GLSL ES 3.00 source defining `vec4 shadeNode(in NodeInput n)`. Compiled into the node fragment
	 * shader once; it is not a second draw.
	 */
	glsl: string;
	/** Extra uniforms by name, scalar or vec2/3/4, updated with `setNodeShaderUniform`. */
	uniforms?: Readonly<Record<string, number | readonly number[]>>;
}

interface GraphraumOptions { nodeShader?: GraphraumNodeShader }
interface Graphraum { setNodeShaderUniform(name: string, value: number | readonly number[]): void }
```

The fixed input contract:

```glsl
struct NodeInput {
	vec2  uv;          // shape space, [-1, 1], aspect-corrected
	float sdf;         // signed distance to the edge, positive inside, in uv units
	float aspect;      // width / height
	float pixelSize;   // on-screen height of the node in CSS pixels
	vec4  fill;        // resolved fill after style and state, linear
	vec4  stroke;      // stroke colour, alpha is the stroke width in uv units
	vec3  normal;      // view space, from the sphere or bevel
	int   state;       // 0 none, 1 hovered, 2 focused, 3 selected
	float time;        // seconds since start, only advances while the host frame loop runs
};
// return value: premultiplied-free linear colour, alpha 0 discards. Depth, picking and shape are not hookable.
```

### How it keeps performance

The hook is inserted by string replacement at program compile time, so there is no runtime indirection; the compiled program is one variant and is recompiled only when `glsl` changes. Per-frame cost is whatever the host's GLSL costs; graphraum adds one `time` uniform update. Without `nodeShader`, the default `shadeNode` is the existing body, so the program is the same as on `main` (asserted by a hash of the assembled source in a unit test).

### Bundle impact and entry

`./shader` entry: source assembly, uniform declaration generation, compile error capture. Main entry gets one option check (+0.1 KiB). Not in the main bundle otherwise.

### Interaction with existing features

- **Shapes and picking:** the hook cannot change the silhouette used by picking and endpoint attach (the CPU shape). A hook that discards pixels shows a look that the pointer does not follow; documented.
- **Shading lit/toon, depth:** the hook runs after `sdf` and `normal` are computed and before output encoding; `gl_FragDepth` stays owned by graphraum.
- **Depth of field, overlay budgets, edge attach:** unchanged.
- **Chips:** `NodeInput` carries the glyph coverage for the text pass in a later revision of the contract; v1 composes text after the hook.
- **2D/3D:** same.

### Tests and benchmark gates

- Unit: assembled source contains the host function exactly once, contract struct unchanged (guard test on the struct text so changes are deliberate), uniform name validation.
- Browser: a trivial hook (constant colour) produces the expected probe; a hook with a compile error leaves the default shader running and reports the GLSL log through diagnostics (`nodeShader: "error"`); `gpuDrawCalls === 2`.
- Benchmark gate: with a no-op hook, GPU frame time within 3 percent of slice 4; main entry within budget.

### Migration

Additive and opt-in. The input struct is versioned (`GRAPHRAUM_NODE_INPUT_VERSION`) so hooks can fail loudly when the contract changes.

### Open questions

1. Is host GLSL acceptable as a supported surface for a library that wants a stable contract? The struct is the contract and must be frozen once released.
2. GLSL ES 3.00 only (WebGL2 is already required)? Confirm.
3. Security: host GLSL is host code like host JS; no sandboxing is attempted. Document it, and keep user-supplied (end-user) shader text out of scope.

---

## Delivery

One slice per approach, in this order. Each slice is its own PR against `main` that links its issue, includes tests and the gates above, updates `etc/graphraum.api.md` (`bun run api:update`) and the docs guide (`docs/src/content/docs/guide/theme.mdx` for slice 1, a new guide page for slice 2).

| # | Slice | Issue | Entry | Blocked by |
| --- | --- | --- | --- | --- |
| 1 | Neutral defaults and style presets | [#203](https://github.com/yggy-tech/graphraum/issues/203) | main, `./styles` | none |
| 2 | Chips on the GPU (prototype first) | [#204](https://github.com/yggy-tech/graphraum/issues/204) | main hook, `./text` | 1 |
| 3 | Zoom-based host DOM rendering | [#205](https://github.com/yggy-tech/graphraum/issues/205) | main (overlay) | 1 |
| 4 | Node style variants | [#206](https://github.com/yggy-tech/graphraum/issues/206) | main | 1, soft dependency on 2 |
| 5 | Custom shader hook | [#207](https://github.com/yggy-tech/graphraum/issues/207) | `./shader` | 1, 2, 4, and only if gaps remain |

Slice 1 is split into two merges if needed to protect the budget: first the types, resolver, `instanceState`, halo branch and CSS variables with the default unchanged; then the default flip with `!`.

## Verification

Per slice, before merge:

- `bun run check`, `bun run test`, `bun run test:browser`, `bun run build`, `bun run check:package` (bundle size per entry), `bun run api:update` committed.
- Browser tests assert pixels with probes and `getDiagnostics().gpuDrawCalls === 2` for every new feature enabled; no image snapshots.
- Benchmark gate reported in the PR with fixture size, browser, pixel ratio, protocol and the full result, against the same fixture on `main`. A claim is not generalized beyond what was measured.
- Visual styling is checked manually at desktop and mobile widths for the presets and for chips.
- With every new option omitted and `classicDark` selected (halos off, so their shader define is off), a hash of the assembled node and edge shader sources equals the hash on `main`, and the per-node attribute writes in `setData` are unchanged (unit test), which is how "exactly as performant as today" is enforced.

For this spec PR: docs only; commit lint and the docs build run in CI.
