import { resolveNodeAxes } from "./node-axes";
import { containsNodePoint } from "./node-shapes";
import type { GraphraumMode, GraphraumNodeShape, GraphraumPosition } from "./types";

export type EndpointAttach = "boundary" | "center";

export const DEFAULT_ENDPOINT_ATTACH: EndpointAttach = "boundary";
export const DEFAULT_ENDPOINT_CLEARANCE = 0.75;

export interface EndpointOutline {
	height?: number;
	shape?: GraphraumNodeShape;
	size?: number;
	strokeWidth?: number;
	width?: number;
}

export interface TrimEdgeEndpointsInput {
	attach?: EndpointAttach;
	clearance?: number;
	/**
	 * `3d` trims along the 3D segment so ends meet camera-facing outlines; exact for circles,
	 * approximate for other shapes. Default `2d`.
	 */
	mode?: GraphraumMode;
	source: GraphraumPosition;
	sourceOutline: EndpointOutline;
	target: GraphraumPosition;
	targetOutline: EndpointOutline;
}

/**
 * Distance from the node center to its outline (stroke included) along a unit heading in the
 * billboard plane, in world units. Every shape fits its `[-1, 1]` box, so the box diagonal bounds
 * the search.
 */
function outlineRadius(outline: EndpointOutline, headingX: number, headingY: number): number {
	const { height, width } = resolveNodeAxes({
		height: outline.height,
		size: outline.size,
		width: outline.width,
	});
	const stroke = Math.max(0, outline.strokeWidth ?? 0);
	const halfWidth = width + stroke;
	const halfHeight = height + stroke;
	let low = 0;
	let high = Math.hypot(halfWidth, halfHeight);
	for (let step = 0; step < 24; step += 1) {
		const mid = (low + high) / 2;
		if (containsNodePoint(outline.shape, (headingX * mid) / halfWidth, (headingY * mid) / halfHeight)) low = mid;
		else high = mid;
	}
	return low;
}

/**
 * How far an edge end stops short of a 3D node's center, in world units: the outline radius (stroke
 * included) less `clearance`. The renderer applies it on screen, where the camera-facing outline
 * is, so it is exact for circles from every view. Other shapes use their radius along +x.
 */
export function outlineReach(outline: EndpointOutline, clearance = DEFAULT_ENDPOINT_CLEARANCE): number {
	return Math.max(0, outlineRadius(outline, 1, 0) - Math.max(clearance, 0));
}

/**
 * Walk from the node center toward the far point and stop on the outline,
 * then pull back by `clearance` so the stroke is not stabbed.
 *
 * In `2d` the outline lies in the xy plane, so only the xy part of the chord counts. In `3d` the
 * billboard faces the camera, so the edge stops one outline radius from the center along the 3D
 * segment. The radius is measured along the chord's world xy heading (or +x when the chord is
 * parallel to z), not along its on-screen heading. For circles the radius is the same in every
 * direction, so the projected end lies on the outline or inside it (where the node covers the
 * edge) from every view. Other shapes are approximate in 3D: an elongated or angular node can end
 * inside its outline or short of it, depending on the camera.
 */
export function attachPointOnOutline(
	center: GraphraumPosition,
	far: GraphraumPosition,
	outline: EndpointOutline,
	clearance = DEFAULT_ENDPOINT_CLEARANCE,
	mode: GraphraumMode = "2d",
): GraphraumPosition {
	const dx = far.x - center.x;
	const dy = far.y - center.y;
	const dz = (far.z ?? 0) - (center.z ?? 0);
	const length = Math.hypot(dx, dy, dz);
	if (length < 1e-6) return { x: center.x, y: center.y, z: center.z ?? 0 };

	const planar = Math.hypot(dx, dy);
	const reach = mode === "3d" ? length : planar;
	const radius = planar < 1e-6 ? outlineRadius(outline, 1, 0) : outlineRadius(outline, dx / planar, dy / planar);
	const outlineT = reach < 1e-6 ? 1 : Math.min(1, radius / reach);

	const clearanceT = Math.min(Math.max(clearance, 0) / length, 0.45);
	const t = Math.max(0, outlineT - clearanceT);
	return {
		x: center.x + dx * t,
		y: center.y + dy * t,
		z: (center.z ?? 0) + dz * t,
	};
}

/** Trim both ends of a center-to-center chord (or curve endpoints) to node boundaries. */
export function trimEdgeEndpoints(input: TrimEdgeEndpointsInput): {
	source: GraphraumPosition;
	target: GraphraumPosition;
} {
	if ((input.attach ?? DEFAULT_ENDPOINT_ATTACH) === "center") {
		return {
			source: { x: input.source.x, y: input.source.y, z: input.source.z ?? 0 },
			target: { x: input.target.x, y: input.target.y, z: input.target.z ?? 0 },
		};
	}
	const clearance = input.clearance ?? DEFAULT_ENDPOINT_CLEARANCE;
	const source = attachPointOnOutline(input.source, input.target, input.sourceOutline, clearance, input.mode);
	const target = attachPointOnOutline(input.target, input.source, input.targetOutline, clearance, input.mode);
	const ox = input.target.x - input.source.x;
	const oy = input.target.y - input.source.y;
	const oz = (input.target.z ?? 0) - (input.source.z ?? 0);
	const dx = target.x - source.x;
	const dy = target.y - source.y;
	const dz = (target.z ?? 0) - (source.z ?? 0);
	// Collapsed or crossed after trim (overlapping nodes) — fall back to centers.
	if (dx * ox + dy * oy + dz * oz <= 1e-8) {
		return {
			source: { x: input.source.x, y: input.source.y, z: input.source.z ?? 0 },
			target: { x: input.target.x, y: input.target.y, z: input.target.z ?? 0 },
		};
	}
	return { source, target };
}
