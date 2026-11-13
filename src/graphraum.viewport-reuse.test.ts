import { OrthographicCamera } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import type { Graphraum } from "./graphraum";
import {
	createGraph,
	destroyGraphs,
	edgeInstancesByEdge,
	internals,
	mixedFixture,
	seededRandom,
	unusedVisibleSlots,
} from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumOptions } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));
afterEach(() => {
	destroyGraphs();
	vi.restoreAllMocks();
});

interface NodeInternals {
	nodeMesh: {
		count: number;
		geometry: { getAttribute(name: string): { array: ArrayLike<number>; itemSize: number } };
		instanceColor: { array: ArrayLike<number> };
		instanceMatrix: { array: ArrayLike<number> };
	};
	nodePickMesh: { count: number; instanceMatrix: { array: ArrayLike<number> } };
	nodeSlots: Int32Array;
	visibleNodeIndices: readonly number[];
	writeNodeInstance(...args: unknown[]): void;
	patchEdgeSlots(...args: unknown[]): boolean;
	pickableEdgeSegments: { edgeIndex: number; hitSlop: number; x1: number; y1: number; x2: number; y2: number }[];
}

const ATTRIBUTES = ["instanceShape", "instanceIcon", "instanceStrokeWidth", "instanceStrokeColor"] as const;

/** Every drawn node's instance data, keyed by node id so slot order does not matter. */
function drawnNodes(graph: Graphraum) {
	const inner = internals(graph) as unknown as NodeInternals & ReturnType<typeof internals>;
	const slice = (array: ArrayLike<number>, slot: number, size: number) =>
		Array.from({ length: size }, (_, offset) => array[slot * size + offset]);
	const entries = inner.visibleNodeIndices.map((index, slot) => {
		expect(inner.nodeSlots[index], "slot map and slot list agree").toBe(slot);
		return [
			inner.data.nodes[index]?.id,
			{
				attributes: ATTRIBUTES.map((name) => {
					const attribute = inner.nodeMesh.geometry.getAttribute(name);
					return slice(attribute.array, slot, attribute.itemSize);
				}),
				color: slice(inner.nodeMesh.instanceColor.array, slot, 3),
				matrix: slice(inner.nodeMesh.instanceMatrix.array, slot, 16),
				pickMatrix: slice(inner.nodePickMesh.instanceMatrix.array, slot, 16),
			},
		] as const;
	});
	expect(inner.nodeMesh.count).toBe(entries.length);
	expect(inner.nodePickMesh.count).toBe(entries.length);
	expect(new Set(entries.map(([id]) => id)).size, "no node is drawn twice").toBe(entries.length);
	return new Map(entries);
}

function edgeDiagnostics(graph: Graphraum) {
	const { subPixelEdgesSkipped, visibleEdgeMarkers, visibleEdgeSegments, visibleEdges } = graph.getDiagnostics();
	return { subPixelEdgesSkipped, visibleEdgeMarkers, visibleEdgeSegments, visibleEdges };
}

function viewAt(graph: Graphraum, zoom: number, x: number, y: number) {
	const { camera } = internals(graph);
	if (camera instanceof OrthographicCamera) camera.zoom = zoom;
	camera.position.x = x;
	camera.position.y = y;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();
}

/** What a click could hit, per edge and rounded: the pick list lists slots, whose order differs. */
function pickable(graph: Graphraum) {
	const { pickableEdgeSegments } = internals(graph) as unknown as NodeInternals;
	return pickableEdgeSegments
		.filter((segment) => segment.edgeIndex >= 0)
		.map((segment) => [
			segment.edgeIndex,
			...[segment.hitSlop, segment.x1, segment.y1, segment.x2, segment.y2].map((value) => Math.round(value * 1e4)),
		])
		.sort((a, b) => a.join().localeCompare(b.join()));
}

const CONFIGS: readonly {
	name: string;
	options: GraphraumOptions;
	reused: readonly [min: number, max: number];
	edgesKept: readonly [min: number, max: number];
}[] = [
	{ name: "detail", options: { mode: "2d" }, reused: [20, 120], edgesKept: [60, 120] },
	{ name: "node budget cut", options: { maxVisibleNodes: 30, mode: "2d" }, reused: [1, 119], edgesKept: [40, 119] },
	{ name: "edge budget", options: { maxVisibleEdges: 48, mode: "2d" }, reused: [20, 120], edgesKept: [30, 119] },
	{ name: "focus lens", options: { focusLens: { enabled: true }, mode: "2d" }, reused: [0, 0], edgesKept: [0, 0] },
];

describe("2D viewport keeps the instances of nodes that stay visible", () => {
	// Hundreds of seeded camera moves, each compared with a full rewrite: under 1 s locally, about 5 s on CI runners.
	const RANDOM_WALK_TIMEOUT_MS = 30_000;

	test.each(CONFIGS)(
		"$name: random pan and zoom draws what a full rewrite draws",
		({ edgesKept, options, reused }) => {
			const random = seededRandom(97);
			const data = mixedFixture(220, 500, 5);
			const graph = createGraph(options);
			const twin = createGraph(options);
			graph.setData(data);
			twin.setData(data);
			const written = vi.spyOn(internals(graph) as unknown as NodeInternals, "writeNodeInstance");
			let zoom = 2;
			let x = 0;
			let y = 0;
			let reusedSteps = 0;
			const patched = vi.spyOn(internals(graph) as unknown as NodeInternals, "patchEdgeSlots");
			for (let step = 0; step < 120; step += 1) {
				if (random() < 0.5) {
					x += (random() - 0.5) * 120;
					y += (random() - 0.5) * 120;
				} else {
					zoom = Math.min(30, Math.max(0.6, zoom * (0.7 + random() * 0.7)));
				}
				viewAt(graph, zoom, x, y);
				viewAt(twin, zoom, x, y);
				const before = written.mock.calls.length;
				internals(graph).handleViewChange();
				const writes = written.mock.calls.length - before;
				internals(twin).materializeViewport();

				const drawn = drawnNodes(graph);
				expect([...drawn.keys()].sort(), `step ${step}`).toEqual([...drawnNodes(twin).keys()].sort());
				expect(drawn, `step ${step}`).toEqual(drawnNodes(twin));
				expect(edgeInstancesByEdge(graph), `step ${step}`).toEqual(edgeInstancesByEdge(twin));
				expect(unusedVisibleSlots(graph), `step ${step}`).toBe(0);
				expect(pickable(graph), `step ${step}`).toEqual(pickable(twin));
				expect(edgeDiagnostics(graph), `step ${step}`).toEqual(edgeDiagnostics(twin));
				expect(graph.getDiagnostics().visibleNodes).toBe(twin.getDiagnostics().visibleNodes);
				if (writes < drawn.size) reusedSteps += 1;
			}
			expect(reusedSteps).toBeGreaterThanOrEqual(reused[0]);
			expect(reusedSteps).toBeLessThanOrEqual(reused[1]);
			const edgeSteps = patched.mock.results.filter((result) => result.value === true).length;
			expect(edgeSteps).toBeGreaterThanOrEqual(edgesKept[0]);
			expect(edgeSteps).toBeLessThanOrEqual(edgesKept[1]);
		},
		RANDOM_WALK_TIMEOUT_MS,
	);

	test("a selection colour survives the camera moving while the node stays visible", () => {
		const data = mixedFixture(60, 120, 9);
		const graph = createGraph({ mode: "2d" });
		const twin = createGraph({ mode: "2d" });
		for (const target of [graph, twin]) {
			target.setData(data);
			viewAt(target, 1, 0, 0);
			internals(target).materializeViewport();
			target.setNodeState("selected", ["n3", "n4"]);
		}
		viewAt(graph, 1, 10, 6);
		viewAt(twin, 1, 10, 6);
		internals(graph).handleViewChange();
		internals(twin).materializeViewport();
		expect(drawnNodes(graph)).toEqual(drawnNodes(twin));
	});
});
