import type { InstancedBufferAttribute } from "three";
import { describe, expect, test } from "vitest";

import { packEdgeInstances } from "./edge-materialize";
import type { PickableEdgeSegment } from "./edge-picking";
import { createEdgeGeometry, writeEdgeMarkerInstance, writeEdgeSegmentInstance } from "./edge-rendering";
import type { EdgeStateStyling } from "./edge-state";
import { buildVisibleEdgeLayouts, patchVisibleEdgeInstances, patchVisibleEdgePaint } from "./edge-viewport-patch";

describe("buildVisibleEdgeLayouts", () => {
	test("records segment and marker slot ranges per edge", () => {
		const packed = packEdgeInstances({
			defaults: { color: "#226f54", opacity: 0.85, width: 1.5 },
			edgeIndices: [0, 1],
			edgeVisuals: [{ path: "straight", marker: "triangle", markerEnd: "target" }, { path: "quadratic" }],
			endpointPositions: new Float32Array([0, 0, 0, 10, 0, 0, 1, 1, 0, 11, 1, 0]),
			mode: "2d",
			tier: "detail",
		});
		const layouts = buildVisibleEdgeLayouts(packed.segments, packed.markers, packed.segments.length);
		expect(layouts.get(0)).toEqual({
			markerCount: 1,
			markerStart: packed.segments.length,
			segmentCount: 1,
			segmentStart: 0,
		});
		expect(layouts.get(1)?.segmentCount).toBeGreaterThan(1);
		expect(layouts.get(1)?.markerCount).toBe(0);
	});
});

describe("patchVisibleEdgeInstances", () => {
	test("updates segment attributes in place when endpoint positions move", () => {
		const geometry = createEdgeGeometry(32);
		const endpointPositions = new Float32Array([0, 0, 0, 10, 0, 0]);
		const packed = packEdgeInstances({
			defaults: { color: "#226f54", opacity: 0.85, width: 1.5 },
			edgeIndices: [0],
			edgeVisuals: [{ path: "straight" }],
			endpointPositions,
			mode: "2d",
			tier: "detail",
		});
		for (const [slot, segment] of packed.segments.entries()) {
			writeEdgeSegmentInstance(geometry, slot, segment);
		}
		const layouts = buildVisibleEdgeLayouts(packed.segments, packed.markers, packed.segments.length);
		const pickable: PickableEdgeSegment[] = packed.segments.map((segment) => ({
			edgeIndex: 0,
			hitSlop: 2,
			x1: segment.x1,
			x2: segment.x2,
			y1: segment.y1,
			y2: segment.y2,
		}));

		endpointPositions.set([2, 3, 0, 12, 4, 0]);
		const result = patchVisibleEdgeInstances(
			geometry,
			{
				changedEdgeIndices: [0],
				defaults: { color: "#226f54", opacity: 0.85, width: 1.5 },
				edgeVisuals: [{ path: "straight" }],
				endpointPositions,
				layouts,
				minHitSlop: 2,
				mode: "2d",
				tier: "detail",
			},
			pickable,
		);

		expect(result.ok).toBe(true);
		expect(result.pickableSegments[0]).toMatchObject({ x1: 2, y1: 3, x2: 12, y2: 4 });
		const endA = geometry.getAttribute("instanceEndA");
		expect(endA.getX(0)).toBeCloseTo(2);
		expect(endA.getY(0)).toBeCloseTo(3);
		const endB = geometry.getAttribute("instanceEndB");
		expect(endB.getX(0)).toBeCloseTo(12);
		expect(endB.getY(0)).toBeCloseTo(4);
	});

	test("returns ok=false when segment count would change", () => {
		const geometry = createEdgeGeometry(32);
		const endpointPositions = new Float32Array([0, 0, 0, 10, 0, 0]);
		const overview = packEdgeInstances({
			defaults: { color: "#226f54", opacity: 0.85, width: 1.5 },
			edgeIndices: [0],
			edgeVisuals: [{ path: "quadratic" }],
			endpointPositions,
			mode: "2d",
			tier: "overview",
		});
		const layouts = buildVisibleEdgeLayouts(overview.segments, overview.markers, overview.segments.length);
		const pickable: PickableEdgeSegment[] = overview.segments.map((segment) => ({
			edgeIndex: 0,
			hitSlop: 2,
			x1: segment.x1,
			x2: segment.x2,
			y1: segment.y1,
			y2: segment.y2,
		}));

		const result = patchVisibleEdgeInstances(
			geometry,
			{
				changedEdgeIndices: [0],
				defaults: { color: "#226f54", opacity: 0.85, width: 1.5 },
				edgeVisuals: [{ path: "quadratic" }],
				endpointPositions,
				layouts,
				minHitSlop: 2,
				mode: "2d",
				tier: "detail",
			},
			pickable,
		);

		expect(result.ok).toBe(false);
	});
});

describe("patchVisibleEdgeInstances update ranges", () => {
	test("keeps update ranges that are still waiting for upload", () => {
		const geometry = createEdgeGeometry(32);
		const endpointPositions = new Float32Array([0, 0, 0, 10, 0, 0]);
		const input = {
			defaults: { color: "#226f54", opacity: 0.85, width: 1.5 },
			edgeIndices: [0],
			edgeVisuals: [{ path: "straight" as const }],
			endpointPositions,
			mode: "2d" as const,
			tier: "detail" as const,
		};
		const packed = packEdgeInstances(input);
		const layouts = buildVisibleEdgeLayouts(packed.segments, packed.markers, packed.segments.length);
		const color = geometry.getAttribute("instanceColor") as InstancedBufferAttribute;
		color.addUpdateRange(40, 8);

		patchVisibleEdgeInstances(geometry, { ...input, changedEdgeIndices: [0], layouts, minHitSlop: 2 }, []);

		expect(color.updateRanges).toContainEqual({ start: 40, count: 8 });
		expect(color.updateRanges).toContainEqual({ start: 0, count: 4 });
	});
});

describe("patchVisibleEdgePaint", () => {
	const defaults = { color: "#226f54", opacity: 0.55, width: 1.5 };
	const edgeVisuals = [
		{ path: "quadratic" as const, marker: "triangle" as const, markerEnd: "both" as const },
		{ path: "straight" as const, color: "#6d5bd0" },
	];
	const endpointPositions = new Float32Array([0, 0, 0, 10, 0, 0, 1, 1, 0, 11, 1, 0]);

	function packInto(geometry: ReturnType<typeof createEdgeGeometry>, edgeStates?: EdgeStateStyling) {
		const packed = packEdgeInstances({
			defaults,
			edgeIndices: [0, 1],
			edgeStates,
			edgeVisuals,
			endpointPositions,
			mode: "2d",
			tier: "detail",
		});
		for (const [slot, segment] of packed.segments.entries()) writeEdgeSegmentInstance(geometry, slot, segment);
		for (const [offset, marker] of packed.markers.entries()) {
			writeEdgeMarkerInstance(geometry, packed.segments.length + offset, marker);
		}
		return {
			instanceCount: packed.segments.length + packed.markers.length,
			layouts: buildVisibleEdgeLayouts(packed.segments, packed.markers, packed.segments.length),
		};
	}

	test("rewrites only the changed edge colors to match a full pack", () => {
		const selected: EdgeStateStyling = {
			dimmedColor: "#315a51",
			dimmedOpacity: 0.25,
			selectedColor: "#fcfffc",
			stateOf: (edgeIndex) => (edgeIndex === 0 ? "selected" : null),
		};
		const expected = createEdgeGeometry(64);
		packInto(expected, selected);
		const geometry = createEdgeGeometry(64);
		const { instanceCount, layouts } = packInto(geometry);
		const color = geometry.getAttribute("instanceColor") as InstancedBufferAttribute;
		color.clearUpdateRanges();
		color.needsUpdate = false;

		const result = patchVisibleEdgePaint(geometry, {
			changedEdgeIndices: [0, 7],
			defaults,
			edgeStates: selected,
			edgeVisuals,
			instanceCount,
			layouts,
			tier: "detail",
		});

		const layout = layouts.get(0);
		expect(result.ok).toBe(true);
		expect(result.patchedSlots).toBe((layout?.segmentCount ?? 0) + (layout?.markerCount ?? 0));
		expect(Array.from(color.array)).toEqual(Array.from(expected.getAttribute("instanceColor").array));
		expect(color.updateRanges).toEqual([
			{ start: (layout?.segmentStart ?? 0) * 4, count: (layout?.segmentCount ?? 0) * 4 },
			{ start: (layout?.markerStart ?? 0) * 4, count: (layout?.markerCount ?? 0) * 4 },
		]);
		expect(color.version).toBeGreaterThan(0);
		for (const name of ["instanceEndA", "instanceWidth"]) {
			expect((geometry.getAttribute(name) as InstancedBufferAttribute).updateRanges).toEqual([]);
		}
	});

	test("does nothing for edges without visible slots", () => {
		const geometry = createEdgeGeometry(64);
		const { instanceCount, layouts } = packInto(geometry);
		const color = geometry.getAttribute("instanceColor") as InstancedBufferAttribute;
		const version = color.version;
		expect(
			patchVisibleEdgePaint(geometry, {
				changedEdgeIndices: [5],
				defaults,
				edgeStates: { dimmedColor: "#315a51", dimmedOpacity: 0.25, selectedColor: "#fcfffc", stateOf: () => "dimmed" },
				edgeVisuals,
				instanceCount,
				layouts,
				tier: "detail",
			}),
		).toEqual({ ok: true, patchedSlots: 0 });
		expect(color.version).toBe(version);
	});

	test("refuses to write when a layout lies outside the drawn instances", () => {
		const geometry = createEdgeGeometry(64);
		const { instanceCount, layouts } = packInto(geometry);
		const color = geometry.getAttribute("instanceColor") as InstancedBufferAttribute;
		const before = Array.from(color.array);
		const version = color.version;
		color.clearUpdateRanges();
		const result = patchVisibleEdgePaint(geometry, {
			changedEdgeIndices: [1, 0],
			defaults,
			edgeStates: { dimmedColor: "#315a51", dimmedOpacity: 0.25, selectedColor: "#fcfffc", stateOf: () => "dimmed" },
			edgeVisuals,
			instanceCount: instanceCount - 1,
			layouts,
			tier: "detail",
		});
		expect(result).toEqual({ ok: false, patchedSlots: 0 });
		expect(Array.from(color.array)).toEqual(before);
		expect(color.version).toBe(version);
		expect(color.updateRanges).toEqual([]);
	});
});
