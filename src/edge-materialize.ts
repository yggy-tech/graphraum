import {
	DEFAULT_ENDPOINT_ATTACH,
	DEFAULT_ENDPOINT_CLEARANCE,
	type EndpointAttach,
	type EndpointOutline,
	outlineReach,
	trimEdgeEndpoints,
} from "./edge-endpoint-attach";
import { type EdgeLodTier, sampleEdgePath } from "./edge-paths";
import { type EdgeStateStyling, resolveEdgePaint } from "./edge-state";
import type {
	GraphraumColor,
	GraphraumEdgeMarkerEnd,
	GraphraumEdgeStyle,
	GraphraumEdgeVisual,
	GraphraumMode,
} from "./types";

export type { EdgeLodTier };

export interface EdgeSegmentInstance {
	edgeIndex: number;
	x1: number;
	y1: number;
	z1: number;
	x2: number;
	y2: number;
	z2: number;
	color: GraphraumColor;
	width: number;
	opacity: number;
	style: GraphraumEdgeStyle;
	/** World units the shader trims off the start / end on screen (3D boundary ends); 0 keeps it. */
	trimStart: number;
	trimEnd: number;
}

export interface EdgeMarkerInstance {
	edgeIndex: number;
	end: "source" | "target";
	x: number;
	y: number;
	z: number;
	dx: number;
	dy: number;
	dz: number; // direction along edge for orientation
	color: GraphraumColor;
	size: number; // screen px, derived from width * markerSize
	opacity: number;
	/** World units the shader pulls the apex back from (x, y, z) on screen (3D boundary ends). */
	trim: number;
}

export function packEdgeInstances(input: {
	edgeIndices: readonly number[];
	edgeVisuals: readonly Readonly<GraphraumEdgeVisual>[];
	endpointPositions: Float32Array; // 6 floats per edge index in canonical order
	defaults: { color: GraphraumColor; opacity: number; width: number };
	tier: EdgeLodTier;
	/** Soft cap on segment instances; remaining edges are skipped when exceeded. */
	maxSegments?: number;
	/** Default `boundary`. Pass `center` to keep historical center-to-center joins. */
	endpointAttach?: EndpointAttach;
	/** World-unit gap between the rim and the line end. */
	endpointClearance?: number;
	/** Parallel to compiled nodes; required for boundary attach. */
	nodeOutlines?: readonly EndpointOutline[];
	/** Two node indices per edge (source, target), same order as compile-graph. */
	edgeNodeIndices?: Uint32Array;
	/** Host-owned edge states (selection) applied on top of the edge visual. */
	edgeStates?: EdgeStateStyling;
	/**
	 * Render mode. `2d` trims boundary ends here. `3d` keeps node centers and leaves the trim to the
	 * shader, which knows the camera: the end then meets the camera-facing outline from every view.
	 */
	mode: GraphraumMode;
}): { segments: EdgeSegmentInstance[]; markers: EdgeMarkerInstance[]; truncated: boolean } {
	const segments: EdgeSegmentInstance[] = [];
	const markers: EdgeMarkerInstance[] = [];
	let truncated = false;
	const attach = input.endpointAttach ?? DEFAULT_ENDPOINT_ATTACH;
	const clearance = input.endpointClearance ?? DEFAULT_ENDPOINT_CLEARANCE;
	for (const edgeIndex of input.edgeIndices) {
		const visual = input.edgeVisuals[edgeIndex] ?? {};
		const base = edgeIndex * 6;
		let x1 = input.endpointPositions[base] ?? 0;
		let y1 = input.endpointPositions[base + 1] ?? 0;
		let z1 = input.endpointPositions[base + 2] ?? 0;
		let x2 = input.endpointPositions[base + 3] ?? 0;
		let y2 = input.endpointPositions[base + 4] ?? 0;
		let z2 = input.endpointPositions[base + 5] ?? 0;
		let trimSource = 0;
		let trimTarget = 0;
		if (attach === "boundary" && input.nodeOutlines && input.edgeNodeIndices) {
			const sourceIndex = input.edgeNodeIndices[edgeIndex * 2] ?? 0;
			const targetIndex = input.edgeNodeIndices[edgeIndex * 2 + 1] ?? 0;
			const sourceOutline = input.nodeOutlines[sourceIndex] ?? {};
			const targetOutline = input.nodeOutlines[targetIndex] ?? {};
			if (input.mode === "3d") {
				trimSource = outlineReach(sourceOutline, clearance);
				trimTarget = outlineReach(targetOutline, clearance);
			} else {
				const trimmed = trimEdgeEndpoints({
					attach,
					clearance,
					source: { x: x1, y: y1, z: z1 },
					target: { x: x2, y: y2, z: z2 },
					sourceOutline,
					targetOutline,
				});
				x1 = trimmed.source.x;
				y1 = trimmed.source.y;
				z1 = trimmed.source.z ?? 0;
				x2 = trimmed.target.x;
				y2 = trimmed.target.y;
				z2 = trimmed.target.z ?? 0;
			}
		}
		const { color, opacity } = resolveEdgePaint(edgeIndex, visual, input.defaults, input.tier, input.edgeStates);
		const width = input.tier === "overview" ? input.defaults.width : (visual.width ?? input.defaults.width);
		const style = input.tier === "overview" ? "solid" : (visual.style ?? "solid");
		const points = sampleEdgePath({
			path: visual.path,
			controlPoints: visual.controlPoints,
			tier: input.tier,
			x1,
			y1,
			z1,
			x2,
			y2,
			z2,
		});
		const segmentSpans = Math.max(0, points.length - 1);
		if (input.maxSegments !== undefined && segments.length + segmentSpans > input.maxSegments) {
			truncated = true;
			break;
		}
		for (let index = 0; index < segmentSpans; index += 1) {
			const from = points[index];
			const to = points[index + 1];
			if (!from || !to) continue;
			segments.push({
				edgeIndex,
				x1: from.x,
				y1: from.y,
				z1: from.z ?? 0,
				x2: to.x,
				y2: to.y,
				z2: to.z ?? 0,
				color,
				width,
				opacity,
				style,
				trimStart: index === 0 ? trimSource : 0,
				trimEnd: index === segmentSpans - 1 ? trimTarget : 0,
			});
		}

		if (input.tier === "overview") continue;
		const marker = visual.marker ?? "none";
		if (marker === "none") continue;
		const markerSize = (visual.markerSize ?? 1) * width;
		const ends: GraphraumEdgeMarkerEnd = visual.markerEnd ?? "target";
		const first = points[0];
		const second = points[1] ?? points[0];
		const last = points.at(-1);
		const previous = points.at(-2) ?? last;
		if (!first || !second || !last || !previous) continue;
		const add = (end: "source" | "target") => {
			const fromSource = end === "source";
			markers.push({
				edgeIndex,
				end,
				x: fromSource ? first.x : last.x,
				y: fromSource ? first.y : last.y,
				z: fromSource ? (first.z ?? 0) : (last.z ?? 0),
				dx: fromSource ? first.x - second.x : last.x - previous.x,
				dy: fromSource ? first.y - second.y : last.y - previous.y,
				dz: fromSource ? (first.z ?? 0) - (second.z ?? 0) : (last.z ?? 0) - (previous.z ?? 0),
				color,
				size: markerSize,
				opacity,
				trim: fromSource ? trimSource : trimTarget,
			});
		};
		if (ends === "source" || ends === "both") add("source");
		if (ends === "target" || ends === "both") add("target");
	}
	return { segments, markers, truncated };
}

/** Map existing diagnostics lodLevel into the edge visual tier. */
export function edgeTierFromDiagnosticsLod(lodLevel: "density" | "detail" | "overview"): EdgeLodTier {
	return lodLevel === "detail" ? "detail" : "overview";
}
