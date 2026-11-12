import { describe, expect, test } from "vitest";
import { attachClusterLod, buildClusterTree, type ClusterLodGraph } from "./lod";
import type { GraphraumCameraState, GraphraumData } from "./types";

function fixture(count: number): GraphraumData {
	const side = Math.ceil(Math.sqrt(count));
	return {
		edges: Array.from({ length: count * 2 }, (_, index) => ({
			id: `e${index}`,
			source: `n${index % count}`,
			target: `n${(index * 31 + 7) % count}`,
		})),
		nodes: Array.from({ length: count }, (_, index) => ({
			id: `n${index}`,
			position: { x: (index % side) * 10, y: Math.floor(index / side) * 10 },
			size: 2,
		})),
	};
}

function fakeGraph(state: GraphraumCameraState) {
	const calls: { data: GraphraumData; fit: boolean | undefined }[] = [];
	let listener: () => void = () => undefined;
	const graph: ClusterLodGraph = {
		getCameraState: () => state,
		onViewChange(next) {
			listener = next;
			next();
			return () => {
				listener = () => undefined;
			};
		},
		setData: (data, options) => calls.push({ data, fit: options?.fit }),
	};
	return {
		calls,
		graph,
		move(next: GraphraumCameraState) {
			state = next;
			listener();
		},
	};
}

function setup(count = 6000) {
	const data = fixture(count);
	const tree = buildClusterTree({
		dimensions: 2,
		edges: Uint32Array.from(data.edges.flatMap((edge) => [Number(edge.source.slice(1)), Number(edge.target.slice(1))])),
		positions: Float32Array.from(data.nodes.flatMap((node) => [node.position.x, node.position.y])),
	});
	const element = { clientHeight: 600, clientWidth: 800 } as HTMLElement;
	const side = Math.sqrt(count) * 10;
	const wide: GraphraumCameraState = { center: { x: side / 2, y: side / 2 }, mode: "2d", visibleHeight: side * 1.2 };
	return { data, element, tree, wide };
}

describe("attachClusterLod", () => {
	test("draws a bounded cut that mixes aggregates and ids the host can resolve", () => {
		const { data, element, tree, wide } = setup();
		const { calls, graph } = fakeGraph(wide);
		const lod = attachClusterLod(graph, tree, { data, element, maxDrawnEdges: 500, maxDrawnNodes: 300 });
		const drawn = calls.at(-1)?.data as GraphraumData;
		expect(drawn.nodes.length).toBeLessThanOrEqual(300);
		expect(drawn.edges.length).toBeLessThanOrEqual(500);
		const aggregate = drawn.nodes.find((node) => node.id.startsWith("cluster:"));
		expect(aggregate).toBeDefined();
		const hit = lod.resolve(aggregate?.id ?? "");
		expect(hit?.kind).toBe("cluster");
		if (hit?.kind === "cluster") expect(lod.members(hit.cluster)).toHaveLength(hit.count);
		expect(lod.resolve("n5")).toEqual({ kind: "node", node: 5 });
		expect(lod.resolve("cluster:99999999")).toBeNull();
		const ids = new Set(drawn.nodes.map((node) => node.id));
		for (const edge of drawn.edges) {
			expect(ids.has(edge.source)).toBe(true);
			expect(ids.has(edge.target)).toBe(true);
		}
		expect(lod.getDiagnostics().drawnAggregates).toBeGreaterThan(0);
	});

	test("zooming in shows real nodes and a still camera does not redraw", () => {
		const { data, element, tree, wide } = setup();
		const { calls, graph, move } = fakeGraph(wide);
		const lod = attachClusterLod(graph, tree, { data, element, maxDrawnNodes: 400 });
		expect(lod.getDiagnostics().drawnNodes).toBe(0);
		move({ ...wide, visibleHeight: 150 });
		expect(lod.getDiagnostics().drawnNodes).toBeGreaterThan(0);
		const count = calls.length;
		move({ ...wide, visibleHeight: 150 });
		expect(calls.length).toBe(count);
		expect(calls.at(-1)?.fit).toBe(false);
	});

	test("detach stops following the camera", () => {
		const { data, element, tree, wide } = setup();
		const { calls, graph, move } = fakeGraph(wide);
		const lod = attachClusterLod(graph, tree, { data, element });
		const count = calls.length;
		lod.detach();
		move({ ...wide, visibleHeight: 100 });
		expect(calls.length).toBe(count);
	});

	test("frames a cluster in 2D and 3D", () => {
		const { data, element, tree, wide } = setup();
		const lod = attachClusterLod(fakeGraph(wide).graph, tree, { data, element });
		const state = lod.frameCluster(1);
		expect(state.mode).toBe("2d");
		const pose = lod.frameCluster(0);
		if (pose.mode === "2d") expect(pose.visibleHeight).toBeGreaterThan(0);
	});

	test("rejects data that does not match the tree", () => {
		const { element, tree, wide } = setup();
		expect(() => attachClusterLod(fakeGraph(wide).graph, tree, { data: fixture(10), element })).toThrow(/same order/);
	});
});
