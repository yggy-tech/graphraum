import { resolveNodeAxes } from "./node-axes";
import type { GraphraumColor, GraphraumNodeGeometry, GraphraumTheme } from "./types";

export interface ResolvedNodeStroke {
	strokeColor: GraphraumColor;
	strokeWidthUv: number;
}

/**
 * Ceiling for the stroke ring as a fraction of the shape's half-extent, so a large
 * `strokeWidth` in world units cannot swallow the fill entirely.
 */
const MAX_STROKE_WIDTH_UV = 0.45;

/**
 * Resolves a node's stroke into shader-ready values: `strokeColor` falls back to the theme
 * default, and `strokeWidthUv` converts the world-unit `strokeWidth` into a fraction of
 * `max(width, height)` — the same unit space `containsNodePoint` and the node fragment shader
 * use — so the ring reads consistently regardless of the node's rendered size.
 */
export function resolveNodeStroke(
	node: GraphraumNodeGeometry,
	theme: GraphraumTheme,
	defaultWidth = 0,
): ResolvedNodeStroke {
	const strokeColor = node.strokeColor ?? theme.nodeStroke;
	const strokeWidth = node.strokeWidth ?? defaultWidth;
	if (strokeWidth <= 0) return { strokeColor, strokeWidthUv: 0 };

	const { height, width } = resolveNodeAxes({
		height: node.height,
		nodeId: node.id,
		size: node.size,
		width: node.width,
	});
	const strokeWidthUv = Math.min(strokeWidth / Math.max(width, height), MAX_STROKE_WIDTH_UV);
	return { strokeColor, strokeWidthUv };
}
