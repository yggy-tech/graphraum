import type { InstancedBufferAttribute } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import {
	createGraph,
	destroyGraphs,
	edgeBuffers,
	edgeColorSlots,
	internals,
	mixedFixture,
} from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));
afterEach(() => {
	destroyGraphs();
	vi.restoreAllMocks();
});

describe("incremental edge selection and dimming", () => {
	test("setEdgeSelection patches instance colors without a full viewport materialize", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(30, 60, 1));
		const materialize = vi.spyOn(internals(graph), "materializeViewport");
		const colorAttribute = internals(graph).edgeMesh?.geometry.getAttribute("instanceColor") as
			| InstancedBufferAttribute
			| undefined;
		colorAttribute?.clearUpdateRanges();

		graph.setEdgeSelection(["e0", "e1"]);

		expect(materialize).not.toHaveBeenCalled();
		const layouts = internals(graph).visibleEdgeLayouts;
		const expectedSlots = [0, 1].reduce((count, edgeIndex) => {
			const layout = layouts.get(edgeIndex);
			return count + (layout ? layout.segmentCount + layout.markerCount : 0);
		}, 0);
		const uploadedFloats = (colorAttribute?.updateRanges ?? []).reduce((sum, range) => sum + range.count, 0);
		expect(uploadedFloats).toBe(expectedSlots * 4);
	});

	test("ignores unknown edge ids", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		graph.setEdgeSelection(["e1", "missing"]);
		expect(graph.getDiagnostics().selectedEdges).toBe(1);
	});

	test("clearing the selection restores base edge visuals", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		const before = edgeBuffers(graph);
		graph.setEdgeSelection(["e0", "e3"]);
		expect(edgeBuffers(graph)).not.toEqual(before);
		graph.setEdgeSelection([]);
		expect(edgeBuffers(graph)).toEqual(before);
	});

	test("theme changes re-apply the selected edge color", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		graph.setEdgeSelection(["e1"]);
		graph.setTheme({ selectedEdge: "#ff0000" });
		for (const [red, green, blue] of edgeColorSlots(graph, 1)) {
			expect([red, green, blue]).toEqual([1, 0, 0]);
		}
	});

	test("topology changes prune selected edges that no longer exist", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		graph.setEdgeSelection(["e1", "e2"]);
		graph.applyDataPatch({ removedEdgeIds: ["e1"] });
		expect(graph.getDiagnostics().selectedEdges).toBe(1);
		graph.setData(mixedFixture(10, 2, 5));
		expect(graph.getDiagnostics().selectedEdges).toBe(0);
	});

	test("setEdgeState dims edges without a full viewport materialize", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		const materialize = vi.spyOn(internals(graph), "materializeViewport");
		graph.setEdgeState("dimmed", ["e1", "e2", "missing"]);
		expect(materialize).not.toHaveBeenCalled();
		expect(graph.getDiagnostics().dimmedEdges).toBe(2);
		const [red, green, blue] = [0x31 / 255, 0x5a / 255, 0x51 / 255];
		for (const slot of edgeColorSlots(graph, 1)) {
			expect(slot[3]).toBeCloseTo(0.25);
			expect(slot[0]).toBeCloseTo(red ** 2.2, 1);
			expect(slot[1]).toBeCloseTo(green ** 2.2, 1);
			expect(slot[2]).toBeCloseTo(blue ** 2.2, 1);
		}
	});

	test("selection wins over dimming", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		graph.setEdgeSelection(["e1"]);
		const selected = edgeColorSlots(graph, 1);
		graph.setEdgeState("dimmed", ["e1", "e2"]);
		expect(edgeColorSlots(graph, 1)).toEqual(selected);
		graph.setEdgeSelection([]);
		const dimmed = edgeColorSlots(graph, 2)[0];
		for (const slot of edgeColorSlots(graph, 1)) expect(slot).toEqual(dimmed);
	});

	test("clearing dimmed edges restores base edge visuals", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		const before = edgeBuffers(graph);
		graph.setEdgeState("dimmed", ["e0", "e3", "e4"]);
		expect(edgeBuffers(graph)).not.toEqual(before);
		graph.setEdgeState("dimmed", []);
		expect(edgeBuffers(graph)).toEqual(before);
		expect(graph.getDiagnostics().dimmedEdges).toBe(0);
	});

	test("theme changes re-apply the dimmed edge color and opacity", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		graph.setEdgeState("dimmed", ["e1"]);
		graph.setTheme({ dimmedEdge: "#ff0000", dimmedEdgeOpacity: 0.1 });
		for (const slot of edgeColorSlots(graph, 1)) {
			expect(slot.slice(0, 3)).toEqual([1, 0, 0]);
			expect(slot[3]).toBeCloseTo(0.1);
		}
	});

	test("topology changes prune dimmed edges that no longer exist", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		graph.setEdgeState("dimmed", ["e1", "e2"]);
		graph.applyDataPatch({ removedEdgeIds: ["e1"] });
		expect(graph.getDiagnostics().dimmedEdges).toBe(1);
		graph.setData(mixedFixture(10, 2, 5));
		expect(graph.getDiagnostics().dimmedEdges).toBe(0);
	});

	test("rejects unknown edge states", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		expect(() => graph.setEdgeState("hovered" as "dimmed", ["e1"])).toThrow(/Unknown edge state "hovered"/);
	});

	test("falls back to a full materialize when a visible layout no longer fits the drawn edges", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		const expected = edgeBuffers(graph);
		const mesh = internals(graph).edgeMesh;
		if (!mesh) throw new Error("edge mesh missing");
		internals(graph).visibleEdgeLayouts.set(1, {
			markerCount: 0,
			markerStart: 0,
			segmentCount: 1,
			segmentStart: mesh.count,
		});
		const materialize = vi.spyOn(internals(graph), "materializeViewport");

		graph.setEdgeSelection(["e1"]);

		expect(materialize).toHaveBeenCalledTimes(1);
		graph.setEdgeSelection([]);
		expect(materialize).toHaveBeenCalledTimes(1);
		expect(edgeBuffers(graph)).toEqual(expected);
	});

	test("a layout tick before the next frame keeps the pending full edge upload of a materialize", () => {
		const graph = createGraph({ mode: "3d" });
		const data = mixedFixture(10, 12, 5);
		graph.setData(data);
		const movedNodeId = data.edges[0]?.source ?? "";
		const mesh = internals(graph).edgeMesh;
		if (!mesh) throw new Error("edge mesh missing");
		const color = mesh.geometry.getAttribute("instanceColor") as InstancedBufferAttribute;
		color.clearUpdateRanges();

		graph.setTheme({ edge: "#ff0000" });
		const materialize = vi.spyOn(internals(graph), "materializeViewport");
		graph.updateNodes([{ id: movedNodeId, position: { x: 1, y: 2, z: 3 } }]);

		expect(materialize).not.toHaveBeenCalled();
		expect(color.updateRanges).toContainEqual({ start: 0, count: mesh.count * 4 });
	});
});

describe("host edge colours", () => {
	test("setEdgeColors repaints in place and clearing restores the base visuals", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		const before = edgeBuffers(graph);
		const materialize = vi.spyOn(internals(graph), "materializeViewport");
		graph.setEdgeColors(new Map([["e1", "#ff0000"]]));
		expect(materialize).not.toHaveBeenCalled();
		for (const [red, green, blue] of edgeColorSlots(graph, 1)) expect([red, green, blue]).toEqual([1, 0, 0]);
		expect(graph.getDiagnostics().coloredEdges).toBe(1);
		graph.setEdgeColors([]);
		expect(edgeBuffers(graph)).toEqual(before);
		expect(graph.getDiagnostics().coloredEdges).toBe(0);
	});

	test("ignores unknown ids, lets selection win and prunes removed edges", () => {
		const graph = createGraph();
		graph.setData(mixedFixture(10, 12, 5));
		graph.setEdgeColors([
			["e1", "#ff0000"],
			["e2", "#ff0000"],
			["missing", "#ff0000"],
		]);
		expect(graph.getDiagnostics().coloredEdges).toBe(2);
		graph.setTheme({ selectedEdge: "#00ff00" });
		graph.setEdgeSelection(["e1"]);
		for (const [red, green, blue] of edgeColorSlots(graph, 1)) expect([red, green, blue]).toEqual([0, 1, 0]);
		graph.applyDataPatch({ removedEdgeIds: ["e2"] });
		expect(graph.getDiagnostics().coloredEdges).toBe(1);
	});
});
