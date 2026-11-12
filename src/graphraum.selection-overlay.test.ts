import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { createGraph, destroyGraphs, internals, mixedFixture } from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));
afterEach(() => {
	destroyGraphs();
	vi.restoreAllMocks();
});

const data = mixedFixture(60, 240, 11);

function setup(mode: "2d" | "3d") {
	const graph = createGraph({ maxVisibleEdges: 48, mode });
	graph.setData(data);
	const state = internals(graph) as unknown as ReturnType<typeof internals> & {
		mainEdge: { markers: number; segments: number };
		visibleEdgeLayouts: Map<number, unknown>;
	};
	return { graph, state };
}

/** The bytes of the budgeted layer: every instance before the overlay. */
function mainLayerBytes(state: ReturnType<typeof setup>["state"]) {
	const mesh = state.edgeMesh;
	if (!mesh) throw new Error("edge mesh missing");
	const end = state.mainEdge.segments + state.mainEdge.markers;
	return ["instanceKind", "instanceEndA", "instanceEndB", "instanceColor", "instanceWidth"].map((name) => {
		const attribute = mesh.geometry.getAttribute(name);
		return Array.from(attribute.array.slice(0, end * attribute.itemSize));
	});
}

describe("selection overlay over the edge budget", () => {
	test.each(["2d", "3d"] as const)("%s: selecting a node leaves the budgeted layer alone", (mode) => {
		const { graph, state } = setup(mode);
		expect(graph.getDiagnostics().visibleEdges).toBeLessThanOrEqual(48);
		const before = mainLayerBytes(state);
		const materialize = vi.spyOn(state, "materializeViewport");

		// Pick a node whose edges the budget cut, so the overlay has something to draw.
		const edges = state.data.edges;
		const nodeId = state.data.nodes
			.map((node) => node.id)
			.find((id) => {
				const incident = edges.filter((edge) => edge.source === id || edge.target === id);
				return incident.length > 0 && incident.every((edge) => !state.visibleEdgeLayouts.has(edges.indexOf(edge)));
			});
		expect(nodeId).toBeDefined();
		graph.setNodeState("selected", [nodeId as string]);

		expect(materialize).not.toHaveBeenCalled();
		expect(mainLayerBytes(state)).toEqual(before);
		for (const edge of edges.filter((candidate) => candidate.source === nodeId || candidate.target === nodeId)) {
			expect(state.visibleEdgeLayouts.has(edges.indexOf(edge))).toBe(true);
		}
		const diagnostics = graph.getDiagnostics();
		const drawn = [...state.visibleEdgeLayouts.values()];
		expect(diagnostics.visibleEdgeSegments).toBe(drawn.reduce((sum, layout) => sum + layout.segmentCount, 0));
		expect(diagnostics.visibleEdges).toBe(drawn.filter((layout) => layout.segmentCount > 0).length);

		graph.setNodeState("selected", []);
		expect(materialize).not.toHaveBeenCalled();
		expect(mainLayerBytes(state)).toEqual(before);
		expect(graph.getDiagnostics().visibleEdges).toBeLessThanOrEqual(48);
	});

	test("a selected edge is drawn once and does not move the layer", () => {
		const { graph, state } = setup("2d");
		const before = mainLayerBytes(state);
		const cut = state.data.edges.findIndex((_, index) => !state.visibleEdgeLayouts.has(index));
		const materialize = vi.spyOn(state, "materializeViewport");
		graph.setEdgeSelection([state.data.edges[cut]?.id ?? ""]);
		expect(materialize).not.toHaveBeenCalled();
		expect(state.visibleEdgeLayouts.has(cut)).toBe(true);
		expect(mainLayerBytes(state)).toEqual(before);
	});
});
