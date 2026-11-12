import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { Graphraum } from "./graphraum";
import {
	attachClusterLod,
	buildClusterTree,
	type ClusterLodHandle,
	type ClusterLodOptions,
	nodeColorKeys,
} from "./lod";
import { MINIMUM_SCALE } from "./lod-transition";
import { FakeElement, installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumCameraState, GraphraumData, GraphraumNode } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));

const graphs: Graphraum[] = [];
afterEach(() => {
	for (const graph of graphs.splice(0)) graph.destroy();
});

const COLORS = ["#e63946", "#2a9d8f", "#457b9d"];

function fixture(count: number): GraphraumData {
	const side = Math.ceil(Math.sqrt(count));
	return {
		edges: Array.from({ length: count * 2 }, (_, index) => ({
			id: `e${index}`,
			source: `n${index % count}`,
			target: `n${(index * 31 + 7) % count}`,
		})),
		nodes: Array.from({ length: count }, (_, index) => ({
			color: COLORS[(index * 7 + Math.floor(index / side)) % COLORS.length],
			id: `n${index}`,
			position: { x: (index % side) * 10, y: Math.floor(index / side) * 10 },
			size: 2,
		})),
	};
}

/** A manual frame clock: `frame(ms)` advances time and runs what was scheduled. */
function manualClock() {
	let now = 0;
	let queue: ((now: number) => void)[] = [];
	return {
		frame(milliseconds: number) {
			now += milliseconds;
			const run = queue;
			queue = [];
			for (const callback of run) callback(now);
		},
		pending: () => queue.length,
		schedule(callback: (now: number) => void) {
			queue.push(callback);
			return () => {
				queue = queue.filter((entry) => entry !== callback);
			};
		},
	};
}

function setup(count = 6000, extra: Partial<ClusterLodOptions> = {}) {
	const data = fixture(count);
	const tree = buildClusterTree({
		colors: nodeColorKeys(data.nodes),
		dimensions: 2,
		edges: Uint32Array.from(data.edges.flatMap((edge) => [Number(edge.source.slice(1)), Number(edge.target.slice(1))])),
		positions: Float32Array.from(data.nodes.flatMap((node) => [node.position.x, node.position.y])),
	});
	const graph = new Graphraum(new FakeElement(800, 600) as unknown as HTMLElement, { mode: "2d" });
	graphs.push(graph);
	const element = Object.assign(new EventTarget(), { clientHeight: 600, clientWidth: 800 }) as unknown as HTMLElement;
	const clock = manualClock();
	const side = Math.sqrt(count) * 10;
	const wide: GraphraumCameraState = { center: { x: side / 2, y: side / 2 }, mode: "2d", visibleHeight: side * 1.2 };
	graph.setCameraState(wide);
	const lod = attachClusterLod(graph, tree, {
		data,
		element,
		fit: false,
		labels: false,
		maxDrawnEdges: 800,
		maxDrawnNodes: 300,
		prefersReducedMotion: () => false,
		schedule: clock.schedule,
		...extra,
	});
	return { clock, data, element, graph, lod, side, tree, wide };
}

const internals = (graph: Graphraum) =>
	graph as unknown as { data: { edges: { id: string }[]; nodes: GraphraumNode[] } };
const drawnNodes = (graph: Graphraum) => internals(graph).data.nodes;
const move = (graph: Graphraum, state: GraphraumCameraState) => {
	graph.setCameraState(state);
	(graph as unknown as { renderFrame(): void }).renderFrame();
};

describe("attachClusterLod", () => {
	test("draws a bounded cut that mixes aggregates and ids the host can resolve", () => {
		const { graph, lod } = setup();
		expect(drawnNodes(graph).length).toBeLessThanOrEqual(300);
		expect(internals(graph).data.edges.length).toBeLessThanOrEqual(800);
		const aggregate = drawnNodes(graph).find((node) => node.id.startsWith("cluster:"));
		expect(aggregate).toBeDefined();
		const hit = lod.resolve(aggregate?.id ?? "");
		expect(hit?.kind).toBe("cluster");
		if (hit?.kind === "cluster") expect(lod.members(hit.cluster)).toHaveLength(hit.count);
		expect(lod.resolve("n5")).toEqual({ kind: "node", node: 5 });
		expect(lod.resolve("cluster:99999999")).toBeNull();
		const ids = new Set(drawnNodes(graph).map((node) => node.id));
		for (const edge of internals(graph).data.edges as unknown as { source: string; target: string }[]) {
			expect(ids.has(edge.source)).toBe(true);
			expect(ids.has(edge.target)).toBe(true);
		}
		expect(lod.getDiagnostics().drawnAggregates).toBeGreaterThan(0);
	});

	test("aggregates are bigger than a node and carry the blended colours of their members", () => {
		const { graph } = setup();
		const aggregates = drawnNodes(graph).filter((node) => node.id.startsWith("cluster:"));
		expect(aggregates.every((node) => (node.size ?? 0) > 2 * 2)).toBe(true);
		expect(aggregates.some((node) => node.blend && node.blend.length > 0)).toBe(true);
		for (const node of aggregates) {
			const share = (node.blend ?? []).reduce((sum, entry) => sum + entry.weight, 0);
			expect(share).toBeLessThanOrEqual(1);
		}
	});

	test("a camera change swaps by patch and a still camera does nothing", () => {
		const { graph, lod, wide } = setup(6000, { transitionMilliseconds: 0 });
		const setData = vi.spyOn(graph, "setData");
		const patch = vi.spyOn(graph, "applyDataPatch");
		move(graph, { ...wide, visibleHeight: 60 });
		expect(lod.getDiagnostics().drawnNodes).toBeGreaterThan(0);
		expect(patch).toHaveBeenCalledTimes(1);
		expect(setData).not.toHaveBeenCalled();
		move(graph, { ...wide, visibleHeight: 60 });
		expect(patch).toHaveBeenCalledTimes(1);
	});

	test("detach stops following the camera", () => {
		const { graph, lod, wide } = setup();
		const patch = vi.spyOn(graph, "applyDataPatch");
		lod.detach();
		move(graph, { ...wide, visibleHeight: 100 });
		expect(patch).not.toHaveBeenCalled();
	});

	test("rejects data that does not match the tree", () => {
		const { element, graph, tree } = setup();
		expect(() => attachClusterLod(graph, tree, { data: fixture(10), element })).toThrow(/same order/);
	});
});

describe("split and merge animation", () => {
	function zoomOneStep(context: ReturnType<typeof setup>) {
		const { graph, wide } = context;
		// A step that splits clusters without leaving the budget.
		move(graph, { ...wide, visibleHeight: wide.mode === "2d" ? wide.visibleHeight / 3 : 1 });
	}

	test("children start at their parent and the parent shrinks away, then the end state is the plain cut", () => {
		const context = setup();
		const { clock, graph, lod } = context;
		const before = new Set(drawnNodes(graph).map((node) => node.id));
		const updates = vi.spyOn(graph, "updateNodes");
		zoomOneStep(context);
		expect(lod.getDiagnostics().transitioning).toBe(true);
		const during = drawnNodes(graph);
		const born = during.filter((node) => !before.has(node.id));
		expect(born.length).toBeGreaterThan(0);
		// Newly drawn glyphs are small at first.
		const final = (id: string) => (lod.resolve(id)?.kind === "cluster" ? 1 : 0);
		expect(born.some((node) => final(node.id) === 1)).toBe(true);
		clock.frame(0);
		clock.frame(100);
		expect(updates).toHaveBeenCalled();
		const mid = (updates.mock.calls.at(-1)?.[0] ?? []).filter((update) => update.size !== undefined);
		expect(mid.length).toBeGreaterThan(0);
		clock.frame(500);
		expect(lod.getDiagnostics().transitioning).toBe(false);
		// At rest only the new cut is drawn, at full size.
		const after = drawnNodes(graph);
		expect(after.length).toBeLessThanOrEqual(300);
		expect(clock.pending()).toBe(0);
		expect(after.every((node) => (node.size ?? 0) > MINIMUM_SCALE * 2)).toBe(true);
	});

	test("children appear at the position of the cluster that split", () => {
		const context = setup();
		const before = drawnNodes(context.graph);
		const beforeIds = new Set(before.map((node) => node.id));
		zoomOneStep(context);
		const during = drawnNodes(context.graph);
		const parents = during.filter((node) => beforeIds.has(node.id) && node.id.startsWith("cluster:"));
		const born = during.filter((node) => !beforeIds.has(node.id));
		expect(born.length).toBeGreaterThan(0);
		const atParent = (node: GraphraumNode) =>
			parents.some((parent) => parent.position.x === node.position.x && parent.position.y === node.position.y);
		// Children of a split start on their parent; glyphs that grow in place (a merge elsewhere in the cut) do not.
		expect(born.filter(atParent).length).toBeGreaterThan(0);
		expect(born.every((node) => (node.size ?? 0) < 4)).toBe(true);
	});

	test("zooming back out merges the children into their parent, then drops them", () => {
		const context = setup();
		const { clock, graph, lod, wide } = context;
		zoomOneStep(context);
		clock.frame(0);
		clock.frame(500);
		const zoomedIn = new Set(drawnNodes(graph).map((node) => node.id));
		move(graph, wide);
		expect(lod.getDiagnostics().transitioning).toBe(true);
		const during = drawnNodes(graph);
		// Children of the merging cluster are still there while they travel.
		expect(during.filter((node) => zoomedIn.has(node.id)).length).toBeGreaterThan(0);
		clock.frame(0);
		clock.frame(500);
		expect(lod.getDiagnostics().transitioning).toBe(false);
		expect(drawnNodes(graph).length).toBeLessThanOrEqual(300);
	});

	test("a camera change during the animation waits for it and is then applied", () => {
		const context = setup();
		const { clock, graph, lod, wide } = context;
		zoomOneStep(context);
		expect(lod.getDiagnostics().transitioning).toBe(true);
		const patch = vi.spyOn(graph, "applyDataPatch");
		move(graph, { ...wide, visibleHeight: 60 });
		expect(patch).not.toHaveBeenCalled();
		clock.frame(0);
		clock.frame(400);
		expect(patch.mock.calls.length).toBeGreaterThan(0);
		expect(drawnNodes(graph).length).toBeLessThanOrEqual(300);
	});

	test("reduced motion swaps at once", () => {
		const context = setup(6000, { prefersReducedMotion: () => true });
		zoomOneStep(context);
		expect(context.lod.getDiagnostics().transitioning).toBe(false);
		expect(context.clock.pending()).toBe(0);
	});

	test("a transition of zero length swaps at once", () => {
		const context = setup(6000, { transitionMilliseconds: 0 });
		zoomOneStep(context);
		expect(context.lod.getDiagnostics().transitioning).toBe(false);
	});

	test("the animated and the instant result draw the same nodes and edges", () => {
		const slow = setup();
		const instant = setup(6000, { prefersReducedMotion: () => true });
		zoomOneStep(slow);
		zoomOneStep(instant);
		slow.clock.frame(0);
		slow.clock.frame(400);
		const ids = (graph: Graphraum, list: "nodes" | "edges") =>
			internals(graph)
				.data[list].map((item) => item.id)
				.sort();
		expect(ids(slow.graph, "nodes")).toEqual(ids(instant.graph, "nodes"));
		expect(ids(slow.graph, "edges")).toEqual(ids(instant.graph, "edges"));
	});
});

describe("click to zoom", () => {
	function click(element: HTMLElement, x: number, y: number, pressedAt = { x, y }) {
		element.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: pressedAt.x, clientY: pressedAt.y }));
		element.dispatchEvent(Object.assign(new Event("click"), { clientX: x, clientY: y }));
	}

	function clickSetup(extra: Partial<ClusterLodOptions> = {}) {
		const context = setup(6000, { transitionMilliseconds: 0, zoomMilliseconds: 0, ...extra });
		const aggregate = drawnNodes(context.graph).find((node) => node.id.startsWith("cluster:")) as GraphraumNode;
		const real = context.data.nodes[0] as GraphraumNode;
		vi.spyOn(context.graph, "pick").mockImplementation((x) => (x === 1 ? aggregate.id : x === 2 ? real.id : null));
		return { ...context, aggregate };
	}

	test("zooms to the cluster that was clicked", () => {
		const { aggregate, element, graph, lod } = clickSetup();
		const set = vi.spyOn(graph, "setCameraState");
		click(element, 1, 0);
		const hit = lod.resolve(aggregate.id);
		if (hit?.kind !== "cluster") throw new Error("expected a cluster");
		expect(set).toHaveBeenCalledWith(lod.frameCluster(hit.cluster));
	});

	test("a real node keeps its normal behaviour", () => {
		const { element, graph } = clickSetup();
		const set = vi.spyOn(graph, "setCameraState");
		click(element, 2, 0);
		expect(set).not.toHaveBeenCalled();
	});

	test("a drag that ends on an aggregate does not zoom", () => {
		const { element, graph } = clickSetup();
		const set = vi.spyOn(graph, "setCameraState");
		click(element, 1, 0, { x: 40, y: 40 });
		expect(set).not.toHaveBeenCalled();
	});

	test("clickToZoom false only reports the click", () => {
		const onClusterClick = vi.fn();
		const { element, graph } = clickSetup({ clickToZoom: false, onClusterClick });
		const set = vi.spyOn(graph, "setCameraState");
		click(element, 1, 0);
		expect(onClusterClick).toHaveBeenCalledTimes(1);
		expect(set).not.toHaveBeenCalled();
	});

	test("animates the camera to the cluster over the zoom time", async () => {
		const { aggregate, clock, element, graph, lod } = clickSetup({ zoomMilliseconds: 400 });
		const start = graph.getCameraState();
		click(element, 1, 0);
		clock.frame(0);
		clock.frame(200);
		const middle = graph.getCameraState();
		const hit = lod.resolve(aggregate.id);
		if (hit?.kind !== "cluster") throw new Error("expected a cluster");
		const target = lod.frameCluster(hit.cluster);
		if (start.mode !== "2d" || middle.mode !== "2d" || target.mode !== "2d") throw new Error("expected 2D");
		expect(middle.visibleHeight).toBeLessThan(start.visibleHeight);
		expect(middle.visibleHeight).toBeGreaterThan(target.visibleHeight);
		clock.frame(400);
		const end = graph.getCameraState();
		if (end.mode !== "2d") throw new Error("expected 2D");
		expect(end.visibleHeight).toBeCloseTo(target.visibleHeight, 3);
	});

	test("reduced motion jumps", () => {
		const { aggregate, clock, element, graph, lod } = clickSetup({
			prefersReducedMotion: () => true,
			zoomMilliseconds: 400,
		});
		click(element, 1, 0);
		expect(clock.pending()).toBe(0);
		const hit = lod.resolve(aggregate.id);
		if (hit?.kind !== "cluster") throw new Error("expected a cluster");
		const target = lod.frameCluster(hit.cluster);
		const state = graph.getCameraState();
		if (state.mode !== "2d" || target.mode !== "2d") throw new Error("expected 2D");
		expect(state.visibleHeight).toBeCloseTo(target.visibleHeight, 3);
	});

	test("detach removes the click handler", () => {
		const { element, graph, lod } = clickSetup();
		const set = vi.spyOn(graph, "setCameraState");
		lod.detach();
		click(element, 1, 0);
		expect(set).not.toHaveBeenCalled();
	});
});

describe("incremental swap", () => {
	function instantGraph(mode: ClusterLodHandle extends never ? never : "2d") {
		const graph = new Graphraum(new FakeElement(800, 600) as unknown as HTMLElement, { mode });
		graphs.push(graph);
		return graph;
	}

	test("a cut change by patch equals setData of the new cut", () => {
		const incremental = setup(6000, { transitionMilliseconds: 0 });
		move(incremental.graph, { ...incremental.wide, visibleHeight: 60 });
		const target = incremental.graph;
		const full = instantGraph("2d");
		const snapshot = { edges: internals(target).data.edges, nodes: drawnNodes(target) } as unknown as GraphraumData;
		full.setCameraState(target.getCameraState());
		full.setData(snapshot, { fit: false });
		const ids = (graph: Graphraum, list: "nodes" | "edges") =>
			internals(graph)
				.data[list].map((item) => item.id)
				.sort();
		expect(ids(target, "nodes")).toEqual(ids(full, "nodes"));
		expect(ids(target, "edges")).toEqual(ids(full, "edges"));
		const a = target.getDiagnostics();
		const b = full.getDiagnostics();
		expect([a.totalNodes, a.totalEdges, a.visibleNodes]).toEqual([b.totalNodes, b.totalEdges, b.visibleNodes]);
	});
});
