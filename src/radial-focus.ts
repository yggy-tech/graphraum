import { Color } from "three";

/** Most nodes drawn crisp over the blur; beyond it the nearest neighbours win. */
export const RADIAL_CRISP_NODE_LIMIT = 1024;
/** Most edge instance slots drawn crisp over the blur. */
export const RADIAL_CRISP_EDGE_SLOT_LIMIT = 4096;
/** Blur radii below this many device pixels render sharp. */
export const RADIAL_MIN_BLUR_PIXELS = 0.25;

/** What the radial pass needs for one frame, all in device pixels except `amount` and `vignette`. */
export interface RadialFocusFrame {
	/** 0..1 fade of the whole effect. */
	amount: number;
	focusX: number;
	/** From the bottom, like `gl_FragCoord`. */
	focusY: number;
	innerPixels: number;
	maxBlurPixels: number;
	outerPixels: number;
	/** Vignette strength after the fade; 0 draws none. */
	vignette: number;
	/** Linear RGB the vignette moves toward. */
	vignetteTone: readonly [number, number, number];
}

/**
 * Blur radius in device pixels at `distance` pixels from the focus: none inside `inner`, `maxBlur`
 * from `outer` on, a smoothstep between so there is no ring. Mirrors `radiusAt` in the pass shader.
 */
export function radialBlurRadius(distance: number, inner: number, outer: number, maxBlur: number): number {
	if (outer <= inner) return distance < inner ? 0 : maxBlur;
	const t = Math.min(1, Math.max(0, (distance - inner) / (outer - inner)));
	return maxBlur * t * t * (3 - 2 * t);
}

/**
 * Share of the vignette at a point of the viewport, 0 in the middle and 1 in the corners. `x` and `y`
 * are 0..1 across the viewport. Mirrors the composite shader.
 */
export function vignetteShare(x: number, y: number): number {
	const corner = Math.hypot(x * 2 - 1, y * 2 - 1) / Math.SQRT2;
	const t = Math.min(1, Math.max(0, (corner - 0.45) / 0.55));
	return t * t * (3 - 2 * t);
}

const LINEAR_LUMINANCE_OF_MIDDLE_GREY = 0.18;

/**
 * The colour the vignette moves toward, in linear RGB. Dark backgrounds darken, so edges sink toward
 * near black; light backgrounds stay on their own tone, only dimmed a little, so the frame reads as
 * a soft shade rather than a grey ring. A missing or image background counts as dark.
 */
export function vignetteTone(background: string | null): readonly [number, number, number] {
	if (background === null) return [0, 0, 0];
	const color = new Color(background);
	const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
	const factor = luminance < LINEAR_LUMINANCE_OF_MIDDLE_GREY ? 0.2 : 0.82;
	return [color.r * factor, color.g * factor, color.b * factor];
}

/**
 * The nodes that stay crisp: the anchors (selected, focused, hovered) and the one-hop neighbours of the
 * `expanding` ones (selected and focused), anchors first so a cap never drops them.
 */
export function crispNodeIndices(
	anchors: readonly number[],
	expanding: readonly number[],
	neighbours: (nodeIndex: number) => readonly number[],
	limit: number = RADIAL_CRISP_NODE_LIMIT,
): Set<number> {
	const crisp = new Set(anchors.slice(0, limit));
	for (const nodeIndex of expanding) {
		for (const neighbour of neighbours(nodeIndex)) {
			if (crisp.size >= limit) return crisp;
			crisp.add(neighbour);
		}
	}
	return crisp;
}

/**
 * Edges drawn crisp: every edge with both ends crisp, which covers the selection's own edges and the
 * ones between its neighbours, plus the explicitly selected edges.
 */
export function crispEdgeIndices(
	crispNodes: ReadonlySet<number>,
	incidentEdges: (nodeIndex: number) => readonly number[],
	edgeNodeIndices: ArrayLike<number>,
	selectedEdges: Iterable<number>,
): Set<number> {
	const edges = new Set(selectedEdges);
	for (const nodeIndex of crispNodes) {
		for (const edgeIndex of incidentEdges(nodeIndex)) {
			const source = edgeNodeIndices[edgeIndex * 2];
			const target = edgeNodeIndices[edgeIndex * 2 + 1];
			if (source !== undefined && target !== undefined && crispNodes.has(source) && crispNodes.has(target)) {
				edges.add(edgeIndex);
			}
		}
	}
	return edges;
}
