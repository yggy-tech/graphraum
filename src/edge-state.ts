import type { EdgeLodTier } from "./edge-paths";
import type { GraphraumColor, GraphraumEdgeVisual } from "./types";

/** Host-owned visual state of one edge after precedence (selection wins over dimming, both over a host colour). */
export type EdgePaintState = "dimmed" | "selected" | null;

/** Resolves host edge states during packing and incremental repaint. */
export interface EdgeStateStyling {
	dimmedColor: GraphraumColor;
	/** Opacity cap for dimmed edges: dimming never makes an edge more visible. */
	dimmedOpacity: number;
	selectedColor: GraphraumColor;
	/** State for a compiled edge index. */
	stateOf(edgeIndex: number): EdgePaintState;
	/** Host colour for a compiled edge index (`setEdgeColors`), or null for the edge's own colour. */
	colorOf?(edgeIndex: number): GraphraumColor | null;
}

export interface EdgePaint {
	color: GraphraumColor;
	opacity: number;
}

/**
 * Single source of truth for an edge instance's color and opacity. Full packing and the
 * incremental state repaint both call it, so both paths write identical instance colors.
 */
export function resolveEdgePaint(
	edgeIndex: number,
	visual: Readonly<GraphraumEdgeVisual>,
	defaults: EdgePaint,
	tier: EdgeLodTier,
	edgeStates: EdgeStateStyling | undefined,
): EdgePaint {
	const opacity = tier === "overview" ? defaults.opacity : (visual.opacity ?? defaults.opacity);
	const state = edgeStates?.stateOf(edgeIndex) ?? null;
	if (edgeStates && state === "selected") return { color: edgeStates.selectedColor, opacity };
	if (edgeStates && state === "dimmed") {
		return { color: edgeStates.dimmedColor, opacity: Math.min(opacity, edgeStates.dimmedOpacity) };
	}
	return { color: edgeStates?.colorOf?.(edgeIndex) ?? visual.color ?? defaults.color, opacity };
}

/** IDs present in exactly one of the two sets. */
export function changedIds(current: ReadonlySet<string>, next: ReadonlySet<string>): string[] {
	return [...[...current].filter((id) => !next.has(id)), ...[...next].filter((id) => !current.has(id))];
}
