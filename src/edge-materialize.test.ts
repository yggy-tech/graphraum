import { describe, expect, it } from "vitest";
import { edgeTierFromDiagnosticsLod, packEdgeInstances } from "./edge-materialize";

const endpoints = {
	// edge 0: a(0,0,0) -> b(10,0,0)
	positions: new Float32Array([0, 0, 0, 10, 0, 0]),
};

describe("packEdgeInstances", () => {
	it("packs one segment and omits markers in overview", () => {
		const packed = packEdgeInstances({
			edgeIndices: [0],
			edgeVisuals: [{ marker: "triangle", markerEnd: "both", style: "dashed", width: 3, opacity: 0.9, path: "cubic" }],
			endpointPositions: endpoints.positions,
			defaults: { color: "#226f54", opacity: 0.55, width: 1.5 },
			mode: "2d",
			tier: "overview",
		});
		expect(packed.segments).toHaveLength(1);
		expect(packed.markers).toHaveLength(0);
		expect(packed.truncated).toBe(false);
		expect(packed.segments[0]?.style).toBe("solid");
		expect(packed.segments[0]?.width).toBe(1.5);
	});

	it("expands quadratic and cubic paths in detail", () => {
		const quadratic = packEdgeInstances({
			edgeIndices: [0],
			edgeVisuals: [{ path: "quadratic", controlPoints: [{ x: 5, y: 4, z: 0 }] }],
			endpointPositions: endpoints.positions,
			defaults: { color: "#226f54", opacity: 0.55, width: 1.5 },
			mode: "2d",
			tier: "detail",
		});
		expect(quadratic.segments).toHaveLength(16);

		const cubic = packEdgeInstances({
			edgeIndices: [0],
			edgeVisuals: [{ path: "cubic" }],
			endpointPositions: endpoints.positions,
			defaults: { color: "#226f54", opacity: 0.55, width: 1.5 },
			mode: "2d",
			tier: "detail",
		});
		expect(cubic.segments).toHaveLength(24);
	});

	it("packs triangle markers using end-segment tangents in detail", () => {
		const packed = packEdgeInstances({
			edgeIndices: [0],
			edgeVisuals: [
				{
					marker: "triangle",
					markerEnd: "both",
					width: 2,
					path: "quadratic",
					controlPoints: [{ x: 5, y: 5, z: 0 }],
				},
			],
			endpointPositions: endpoints.positions,
			defaults: { color: "#226f54", opacity: 0.55, width: 1.5 },
			mode: "2d",
			tier: "detail",
		});
		expect(packed.markers).toHaveLength(2);
		expect(packed.markers.map((m) => m.end)).toEqual(["source", "target"]);
		const target = packed.markers.find((marker) => marker.end === "target");
		expect(target?.dx).not.toBe(0);
	});

	it("stops packing when the segment budget is exceeded", () => {
		const packed = packEdgeInstances({
			edgeIndices: [0],
			edgeVisuals: [{ path: "cubic" }],
			endpointPositions: endpoints.positions,
			defaults: { color: "#226f54", opacity: 0.55, width: 1.5 },
			mode: "2d",
			tier: "detail",
			maxSegments: 4,
		});
		expect(packed.truncated).toBe(true);
		expect(packed.segments).toHaveLength(0);
	});

	it("boundary attach shortens straight segments toward node rims", () => {
		const packed = packEdgeInstances({
			edgeIndices: [0],
			edgeVisuals: [{ path: "straight" }],
			endpointPositions: endpoints.positions,
			defaults: { color: "#226f54", opacity: 0.55, width: 1.5 },
			mode: "2d",
			tier: "detail",
			endpointAttach: "boundary",
			edgeNodeIndices: new Uint32Array([0, 1]),
			nodeOutlines: [
				{ shape: "circle", size: 4, strokeWidth: 1 },
				{ shape: "circle", size: 4, strokeWidth: 1 },
			],
		});
		expect(packed.segments).toHaveLength(1);
		const segment = packed.segments[0];
		expect(segment?.x1).toBeGreaterThan(0);
		expect(segment?.x2).toBeLessThan(10);
		expect((segment?.x2 ?? 0) - (segment?.x1 ?? 0)).toBeLessThan(10);
	});
});

describe("edgeTierFromDiagnosticsLod", () => {
	it("maps only the detail LOD level to the detail edge tier", () => {
		expect(edgeTierFromDiagnosticsLod("detail")).toBe("detail");
		expect(edgeTierFromDiagnosticsLod("overview")).toBe("overview");
		expect(edgeTierFromDiagnosticsLod("density")).toBe("overview");
	});
});

describe("3D boundary ends", () => {
	const outlines = [
		{ shape: "circle" as const, size: 4 },
		{ shape: "circle" as const, size: 10, strokeWidth: 1 },
	];
	const pack = (mode: "2d" | "3d") =>
		packEdgeInstances({
			edgeIndices: [0],
			edgeVisuals: [
				{ marker: "triangle", markerEnd: "both", path: "quadratic", controlPoints: [{ x: 5, y: 5, z: 3 }] },
			],
			endpointPositions: new Float32Array([0, 0, 0, 30, 0, 40]),
			defaults: { color: "#226f54", opacity: 0.55, width: 1.5 },
			endpointClearance: 0.75,
			nodeOutlines: outlines,
			edgeNodeIndices: new Uint32Array([0, 1]),
			mode,
			tier: "detail",
		});

	it("keeps node centers and hands the outline reach to the shader, which trims on screen", () => {
		const { segments, markers } = pack("3d");
		const first = segments[0];
		const last = segments.at(-1);
		expect(first).toMatchObject({ x1: 0, y1: 0, z1: 0, trimStart: expect.closeTo(3.25, 5), trimEnd: 0 });
		expect(last).toMatchObject({ x2: 30, y2: 0, z2: 40, trimStart: 0, trimEnd: expect.closeTo(10.25, 5) });
		expect(segments.slice(1, -1).every((segment) => segment.trimStart === 0 && segment.trimEnd === 0)).toBe(true);
		expect(markers.find((marker) => marker.end === "source")).toMatchObject({ x: 0, trim: expect.closeTo(3.25, 5) });
		expect(markers.find((marker) => marker.end === "target")).toMatchObject({ z: 40, trim: expect.closeTo(10.25, 5) });
	});

	it("still trims 2D ends in world space, with nothing left for the shader", () => {
		const { segments, markers } = pack("2d");
		expect(segments[0]?.x1).toBeGreaterThan(0);
		expect(segments.every((segment) => segment.trimStart === 0 && segment.trimEnd === 0)).toBe(true);
		expect(markers.every((marker) => marker.trim === 0)).toBe(true);
	});
});
