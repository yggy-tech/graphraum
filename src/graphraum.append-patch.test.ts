import type { BufferAttribute, InstancedMesh } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import type { Graphraum } from "./graphraum";
import {
	createGraph,
	createShadowGpu,
	destroyGraphs,
	edgeBuffers,
	internals,
	mixedFixture,
	seededRandom,
} from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumData, GraphraumDataPatch, GraphraumEdge, GraphraumNode, GraphraumOptions } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));
afterEach(() => {
	destroyGraphs();
	vi.restoreAllMocks();
});

interface Seen {
	candidateEdges: number;
	incident: readonly (readonly number[])[];
	layouts: Array<[number, unknown]>;
	pickable: number;
	positions: number[];
	slots: Array<[number, number]>;
}

function nodeBuffers(graph: Graphraum) {
	const mesh = Reflect.get(graph, "nodeMesh") as InstancedMesh;
	const read = (attribute: BufferAttribute | null | undefined) =>
		attribute ? Array.from(attribute.array.slice(0, mesh.count * attribute.itemSize)) : [];
	const names = ["instanceShape", "instanceStrokeWidth", "instanceStrokeColor"] as const;
	return {
		color: read(mesh.instanceColor),
		count: mesh.count,
		matrix: Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16)),
		...Object.fromEntries(names.map((name) => [name, read(mesh.geometry.getAttribute(name) as BufferAttribute)])),
	};
}

/** Everything the append path maintains by hand, read back so it can be compared with a fresh build. */
function seen(graph: Graphraum): Seen {
	const inner = graph as unknown as {
		canonicalEdgePositions: Float32Array;
		incidentEdgeIndices: readonly (readonly number[])[];
		pickableEdgeSegments: unknown[];
		visibleEdgeCandidateCount: number;
		visibleNodeSlots: Map<number, number>;
	};
	const edgeCount = internals(graph).data.edges.length;
	return {
		candidateEdges: inner.visibleEdgeCandidateCount,
		incident: inner.incidentEdgeIndices.map((list) => [...list]),
		layouts: [...internals(graph).visibleEdgeLayouts.entries()].sort(([a], [b]) => a - b),
		pickable: inner.pickableEdgeSegments.length,
		positions: Array.from(inner.canonicalEdgePositions.slice(0, edgeCount * 6)),
		slots: [...inner.visibleNodeSlots.entries()].sort(([a], [b]) => a - b),
	};
}

const counts = (graph: Graphraum) => {
	const { visibleEdgeCandidates, visibleEdgeMarkers, visibleEdgeSegments, visibleEdges, visibleNodes, lodLevel } =
		graph.getDiagnostics();
	return { lodLevel, visibleEdgeCandidates, visibleEdgeMarkers, visibleEdgeSegments, visibleEdges, visibleNodes };
};

/** What a fresh load of the same graph produces; the append path has to match it exactly. */
function twinOf(graph: Graphraum, options: GraphraumOptions) {
	const twin = createGraph(options);
	const { nodes, edges } = internals(graph).data;
	twin.setData({ edges: structuredClone(edges), nodes: structuredClone(nodes) } as GraphraumData);
	return twin;
}

function expectSameAsFreshLoad(graph: Graphraum, options: GraphraumOptions, label: string) {
	const twin = twinOf(graph, options);
	expect(edgeBuffers(graph), label).toEqual(edgeBuffers(twin));
	expect(nodeBuffers(graph), label).toEqual(nodeBuffers(twin));
	expect(seen(graph), label).toEqual(seen(twin));
	expect(counts(graph), label).toEqual(counts(twin));
}

/** A seeded append: new nodes with edges to old and new nodes, plus edges and nodes on their own. */
function randomPatch(random: () => number, graph: Graphraum, step: number): GraphraumDataPatch {
	const existing = internals(graph).data.nodes.map((node) => node.id);
	const pick = (ids: readonly string[]) => ids[Math.floor(random() * ids.length)] as string;
	const kind = step % 4;
	const addedNodes: GraphraumNode[] = Array.from({ length: kind === 1 ? 0 : 3 }, (_, offset) => ({
		id: `a${step}-${offset}`,
		position: { x: random() * 400 - 200, y: random() * 400 - 200, z: random() * 40 - 20 },
	}));
	const all = [...existing, ...addedNodes.map((node) => node.id)];
	const edgeCount = kind === 2 ? 0 : 6 + (step % 5);
	const addedEdges: GraphraumEdge[] = Array.from({ length: edgeCount }, (_, offset) => ({
		id: `ae${step}-${offset}`,
		source: pick(all),
		target: offset === 0 ? pick(all) : pick(all),
		...(offset % 2 === 0 ? { marker: "triangle" as const, markerEnd: "both" as const } : { marker: "none" as const }),
		path: (["straight", "quadratic", "cubic"] as const)[(step + offset) % 3],
	}));
	// One self-loop now and then: the incident list holds it once, as a fresh load does.
	if (step % 3 === 0 && addedNodes[0])
		addedEdges.push({ id: `loop${step}`, source: addedNodes[0].id, target: addedNodes[0].id });
	return { addedEdges, addedNodes };
}

const APPENDING: ReadonlyArray<{ name: string; options: GraphraumOptions }> = [
	{ name: "3d", options: { mode: "3d" } },
	{ name: "2d without viewport culling", options: { mode: "2d", viewportCulling: false } },
];

describe("applyDataPatch appends without repacking", () => {
	test.each(APPENDING)("$name: every append matches a fresh load and skips materializeViewport", ({ options }) => {
		const random = seededRandom(11);
		const graph = createGraph(options);
		// 100 nodes and 300 edges leave room (128 / 512) for the appends below.
		graph.setData(mixedFixture(100, 300, 3));
		const materialize = vi.spyOn(internals(graph), "materializeViewport");
		const gpu = createShadowGpu({ includeNodes: true });
		gpu.upload(graph);
		materialize.mockClear();

		for (let step = 0; step < 12; step += 1) {
			graph.applyDataPatch(randomPatch(random, graph, step));
			expectSameAsFreshLoad(graph, options, `after append ${step}`);
			if (step % 2 === 1) {
				gpu.upload(graph);
				for (const { cpu, gpu: uploaded } of gpu.compare(graph))
					expect(uploaded, `GPU after append ${step}`).toEqual(cpu);
			}
		}
		expect(materialize).not.toHaveBeenCalled();
	});

	test("an append between removals still matches a fresh load", () => {
		const options: GraphraumOptions = { mode: "3d" };
		const random = seededRandom(5);
		const graph = createGraph(options);
		graph.setData(mixedFixture(100, 300, 3));
		graph.applyDataPatch(randomPatch(random, graph, 0));
		graph.applyDataPatch({ removedEdgeIds: ["e1", "e2", "e7"], removedNodeIds: ["n4"] });
		expectSameAsFreshLoad(graph, options, "after removal");
		graph.applyDataPatch(randomPatch(random, graph, 1));
		graph.applyDataPatch(randomPatch(random, graph, 2));
		expectSameAsFreshLoad(graph, options, "after appends past a removal");
	});

	test("edge selection and dimming reach appended edges the same way as a fresh load", () => {
		const options: GraphraumOptions = { mode: "3d" };
		const random = seededRandom(9);
		const graph = createGraph(options);
		graph.setData(mixedFixture(100, 300, 3));
		graph.setEdgeSelection(["e3"]);
		graph.setEdgeState("dimmed", ["e5", "e8"]);
		const patch = randomPatch(random, graph, 3);
		graph.applyDataPatch(patch);
		graph.setEdgeSelection([...(patch.addedEdges ?? []).slice(0, 2).map((edge) => edge.id), "e3"]);
		const twin = twinOf(graph, options);
		twin.setEdgeSelection(["e3", ...(patch.addedEdges ?? []).slice(0, 2).map((edge) => edge.id)]);
		twin.setEdgeState("dimmed", ["e5", "e8"]);
		expect(edgeBuffers(graph).instanceColor).toEqual(edgeBuffers(twin).instanceColor);
	});
});

describe("applyDataPatch falls back to a full pass when appending in place would differ", () => {
	test.each([
		["2D with viewport culling", { mode: "2d" } as GraphraumOptions, 1],
		["the density tier", { maxVisibleNodes: 16, mode: "2d" } as GraphraumOptions, 1],
		["the overview tier", { maxVisibleEdges: 48, mode: "3d" } as GraphraumOptions, 1],
	])("%s repacks once and matches a fresh load", (_name, options, calls) => {
		const random = seededRandom(7);
		const graph = createGraph(options);
		graph.setData(mixedFixture(100, 300, 3));
		const materialize = vi.spyOn(internals(graph), "materializeViewport");
		graph.applyDataPatch(randomPatch(random, graph, 0));
		expect(materialize).toHaveBeenCalledTimes(calls);
		const twin = twinOf(graph, options);
		expect(counts(graph)).toEqual(counts(twin));
	});

	test("growing past the allocated capacity still ends up the same as a fresh load", () => {
		const options: GraphraumOptions = { mode: "3d" };
		const graph = createGraph(options);
		graph.setData(mixedFixture(60, 120, 3));
		const patch = randomPatch(seededRandom(3), graph, 0);
		graph.applyDataPatch({
			addedEdges: patch.addedEdges,
			addedNodes: [
				...(patch.addedNodes ?? []),
				...Array.from({ length: 10 }, (_, index) => ({ id: `extra${index}`, position: { x: index, y: 0, z: 0 } })),
			],
		});
		expectSameAsFreshLoad(graph, options, "after growth");
	});
});

describe("edge picking", () => {
	test("3D keeps no pick segments and still picks an edge by raycast", () => {
		const graph = createGraph({ mode: "3d" });
		graph.setData(mixedFixture(100, 300, 3));
		graph.applyDataPatch(randomPatch(seededRandom(2), graph, 0));
		const inner = graph as unknown as { pickableEdgeSegments: unknown[]; visibleEdgeSegmentEdgeIndices: number[] };
		expect(inner.pickableEdgeSegments).toHaveLength(0);
		expect(inner.visibleEdgeSegmentEdgeIndices.length).toBeGreaterThan(0);

		const edgeMesh = internals(graph).edgeMesh;
		const raycaster = Reflect.get(graph, "raycaster") as { intersectObject: (object: unknown) => unknown[] };
		raycaster.intersectObject = (object) => (object === edgeMesh ? [{ instanceId: 3 }] : []);
		const expected = internals(graph).data.edges[inner.visibleEdgeSegmentEdgeIndices[3] as number]?.id;
		expect(graph.pickHit(400, 300)).toEqual({ id: expected, kind: "edge" });
	});

	test("2D keeps one pick segment per drawn segment, also after an append", () => {
		const graph = createGraph({ mode: "2d", viewportCulling: false });
		graph.setData(mixedFixture(100, 300, 3));
		graph.applyDataPatch(randomPatch(seededRandom(2), graph, 0));
		const inner = graph as unknown as { pickableEdgeSegments: unknown[]; visibleEdgeSegmentCount: number };
		expect(inner.pickableEdgeSegments).toHaveLength(inner.visibleEdgeSegmentCount);
	});
});
