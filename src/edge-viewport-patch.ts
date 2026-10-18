import type { BufferGeometry, InstancedBufferAttribute } from "three";

import type { EndpointAttach, EndpointOutline } from "./edge-endpoint-attach";
import { type EdgeMarkerInstance, type EdgeSegmentInstance, packEdgeInstances } from "./edge-materialize";
import type { EdgeLodTier } from "./edge-paths";
import type { PickableEdgeSegment } from "./edge-picking";
import {
	EDGE_INSTANCE_ATTRIBUTES,
	getInstancedAttribute,
	writeEdgeColorSlots,
	writeEdgeMarkerInstance,
	writeEdgeSegmentInstance,
} from "./edge-rendering";
import { type EdgePaint, type EdgeStateStyling, resolveEdgePaint } from "./edge-state";
import type { GraphraumColor, GraphraumEdgeVisual, GraphraumMode } from "./types";

export interface VisibleEdgeLayout {
	markerCount: number;
	markerStart: number;
	segmentCount: number;
	segmentStart: number;
}

/** Records GPU slot ranges for each visible edge after a full viewport materialize. */
export function buildVisibleEdgeLayouts(
	segments: readonly EdgeSegmentInstance[],
	markers: readonly EdgeMarkerInstance[],
	segmentInstanceCount: number,
): Map<number, VisibleEdgeLayout> {
	const layouts = new Map<number, VisibleEdgeLayout>();
	for (const [slot, segment] of segments.entries()) {
		const layout = layouts.get(segment.edgeIndex) ?? {
			markerCount: 0,
			markerStart: segmentInstanceCount,
			segmentCount: 0,
			segmentStart: slot,
		};
		if (layout.segmentCount === 0) layout.segmentStart = slot;
		layout.segmentCount += 1;
		layouts.set(segment.edgeIndex, layout);
	}
	for (const [offset, marker] of markers.entries()) {
		const slot = segmentInstanceCount + offset;
		const layout = layouts.get(marker.edgeIndex) ?? {
			markerCount: 0,
			markerStart: slot,
			segmentCount: 0,
			segmentStart: -1,
		};
		if (layout.markerCount === 0) layout.markerStart = slot;
		layout.markerCount += 1;
		layouts.set(marker.edgeIndex, layout);
	}
	return layouts;
}

export interface PatchVisibleEdgesInput {
	changedEdgeIndices: readonly number[];
	defaults: { color: GraphraumColor; opacity: number; width: number };
	edgeNodeIndices?: Uint32Array;
	edgeStates?: EdgeStateStyling;
	edgeVisuals: readonly Readonly<GraphraumEdgeVisual>[];
	endpointAttach?: EndpointAttach;
	endpointPositions: Float32Array;
	layouts: ReadonlyMap<number, VisibleEdgeLayout>;
	minHitSlop: number;
	mode: GraphraumMode;
	nodeOutlines?: readonly EndpointOutline[];
	tier: EdgeLodTier;
	worldPerPixel: number;
}

export interface PatchVisibleEdgesResult {
	dirtySlotCount: number;
	dirtySlotStart: number;
	ok: boolean;
	pickableSegments: PickableEdgeSegment[];
}

/**
 * Rewrites GPU edge instances for moved endpoints without repacking the whole viewport.
 * Returns ok=false when any visible edge would change segment or marker counts.
 */
export function patchVisibleEdgeInstances(
	geometry: BufferGeometry,
	input: PatchVisibleEdgesInput,
	pickableSegments: readonly PickableEdgeSegment[],
): PatchVisibleEdgesResult {
	const nextPickable = [...pickableSegments];
	let dirtySlotStart = Number.POSITIVE_INFINITY;
	let dirtySlotEnd = -1;
	const seen = new Set<number>();

	for (const edgeIndex of input.changedEdgeIndices) {
		if (seen.has(edgeIndex)) continue;
		seen.add(edgeIndex);
		const layout = input.layouts.get(edgeIndex);
		if (!layout || layout.segmentCount === 0 || layout.segmentStart < 0) continue;

		const packed = packEdgeInstances({
			edgeIndices: [edgeIndex],
			edgeVisuals: input.edgeVisuals,
			endpointPositions: input.endpointPositions,
			defaults: input.defaults,
			tier: input.tier,
			endpointAttach: input.endpointAttach,
			edgeNodeIndices: input.edgeNodeIndices,
			edgeStates: input.edgeStates,
			mode: input.mode,
			nodeOutlines: input.nodeOutlines,
		});
		if (packed.segments.length !== layout.segmentCount || packed.markers.length !== layout.markerCount) {
			return { dirtySlotCount: 0, dirtySlotStart: 0, ok: false, pickableSegments: nextPickable };
		}

		for (const [offset, segment] of packed.segments.entries()) {
			const slot = layout.segmentStart + offset;
			writeEdgeSegmentInstance(geometry, slot, segment);
			nextPickable[slot] = {
				edgeIndex,
				hitSlop: Math.max(input.minHitSlop, (segment.width * input.worldPerPixel) / 2 + 2 * input.worldPerPixel),
				x1: segment.x1,
				x2: segment.x2,
				y1: segment.y1,
				y2: segment.y2,
			};
			dirtySlotStart = Math.min(dirtySlotStart, slot);
			dirtySlotEnd = Math.max(dirtySlotEnd, slot);
		}
		for (const [offset, marker] of packed.markers.entries()) {
			const slot = layout.markerStart + offset;
			writeEdgeMarkerInstance(geometry, slot, marker);
			dirtySlotStart = Math.min(dirtySlotStart, slot);
			dirtySlotEnd = Math.max(dirtySlotEnd, slot);
		}
	}

	if (dirtySlotEnd < dirtySlotStart) {
		return { dirtySlotCount: 0, dirtySlotStart: 0, ok: true, pickableSegments: nextPickable };
	}

	for (const name of EDGE_INSTANCE_ATTRIBUTES) {
		const attribute = geometry.getAttribute(name) as InstancedBufferAttribute;
		// Keep earlier ranges that have not been uploaded yet; three.js merges and clears them on upload.
		attribute.addUpdateRange(
			dirtySlotStart * attribute.itemSize,
			(dirtySlotEnd - dirtySlotStart + 1) * attribute.itemSize,
		);
		attribute.needsUpdate = true;
	}

	return {
		dirtySlotCount: dirtySlotEnd - dirtySlotStart + 1,
		dirtySlotStart,
		ok: true,
		pickableSegments: nextPickable,
	};
}

export interface PatchVisibleEdgePaintInput {
	changedEdgeIndices: Iterable<number>;
	defaults: EdgePaint;
	edgeStates: EdgeStateStyling;
	edgeVisuals: readonly Readonly<GraphraumEdgeVisual>[];
	/** Instances currently drawn (`edgeMesh.count`); every repainted slot must lie below it. */
	instanceCount: number;
	layouts: ReadonlyMap<number, VisibleEdgeLayout>;
	tier: EdgeLodTier;
}

export interface PatchVisibleEdgePaintResult {
	/** False when a layout no longer fits the drawn instances; nothing was written and callers must rematerialize. */
	ok: boolean;
	patchedSlots: number;
}

/**
 * Repaints the color and opacity of visible edges whose host state changed. Slot layout,
 * geometry, and picking stay untouched, so only the changed `instanceColor` ranges upload.
 * Edges without visible slots are skipped; the next materialize paints them from the same state.
 */
export function patchVisibleEdgePaint(
	geometry: BufferGeometry,
	input: PatchVisibleEdgePaintInput,
): PatchVisibleEdgePaintResult {
	const visible = [...input.changedEdgeIndices].flatMap((edgeIndex) => {
		const layout = input.layouts.get(edgeIndex);
		return layout ? [{ edgeIndex, layout }] : [];
	});
	const fits = visible.every(
		({ layout }) =>
			layout.segmentStart + layout.segmentCount <= input.instanceCount &&
			layout.markerStart + layout.markerCount <= input.instanceCount,
	);
	if (!fits) return { ok: false, patchedSlots: 0 };

	const color = getInstancedAttribute(geometry, "instanceColor");
	let patchedSlots = 0;
	for (const { edgeIndex, layout } of visible) {
		const paint = resolveEdgePaint(
			edgeIndex,
			input.edgeVisuals[edgeIndex] ?? {},
			input.defaults,
			input.tier,
			input.edgeStates,
		);
		for (const [start, count] of [
			[layout.segmentStart, layout.segmentCount],
			[layout.markerStart, layout.markerCount],
		] as const) {
			if (count === 0) continue;
			writeEdgeColorSlots(color, start, count, paint);
			color.addUpdateRange(start * color.itemSize, count * color.itemSize);
			patchedSlots += count;
		}
	}
	if (patchedSlots > 0) color.needsUpdate = true;
	return { ok: true, patchedSlots };
}
