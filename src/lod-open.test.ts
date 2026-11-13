import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { Graphraum } from "./graphraum";
import type { OpenClusterLodOptions, OpenedClusterLod } from "./lod";
import { attachClusterLod, buildClusterTree, type ClusterLodHandle, nodeColorKeys, openClusterLod } from "./lod";
import { FakeElement, installFakeBrowserGlobals } from "./test-support/fake-webgl";
import { inProcessWorker } from "./test-support/in-process-worker";
import type { GraphraumData, GraphraumEdge, GraphraumNode } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));

const COLORS = ["#e63946", "#2a9d8f", "#457b9d"];
const opened: ClusterLodHandle[] = [];
const graphs: Graphraum[] = [];
afterEach(() => {
	for (const lod of opened.splice(0)) lod.detach();
	for (const graph of graphs.splice(0)) graph.destroy();
});

function arraysOf(count: number, dimensions: 2 | 3) {
	const side = Math.ceil(Math.sqrt(count));
	const positions = new Float32Array(count * dimensions);
	for (let node = 0; node < count; node += 1) {
		positions[node * dimensions] = (node % side) * 10;
		positions[node * dimensions + 1] = Math.floor(node / side) * 10;
		if (dimensions === 3) positions[node * 3 + 2] = ((node * 17) % 101) - 50;
	}
	const edges = new Uint32Array(count * 4);
	for (let edge = 0; edge < count * 2; edge += 1) {
		edges[edge * 2] = edge % count;
		edges[edge * 2 + 1] = (edge * 31 + 7) % count;
	}
	const colors = Uint32Array.from({ length: count }, (_, node) =>
		Number.parseInt((COLORS[(node * 7 + Math.floor(node / side)) % COLORS.length] as string).slice(1), 16),
	);
	return { colors, dimensions, edges, positions };
}

/** The same graph as objects, for the existing attach path. */
function dataOf(arrays: ReturnType<typeof arraysOf>): GraphraumData {
	const { colors, dimensions, edges, positions } = arrays;
	const nodes: GraphraumNode[] = Array.from({ length: colors.length }, (_, index) => ({
		color: `#${(colors[index] as number).toString(16)}`,
		id: `n${index}`,
		position: {
			x: positions[index * dimensions] as number,
			y: positions[index * dimensions + 1] as number,
			...(dimensions === 3 ? { z: positions[index * 3 + 2] as number } : {}),
		},
	}));
	return {
		edges: Array.from({ length: edges.length / 2 }, (_, index) => ({
			id: `e${index}`,
			source: `n${edges[index * 2]}`,
			target: `n${edges[index * 2 + 1]}`,
		})),
		nodes,
	};
}

const view = (mode: "2d" | "3d") => ({
	element: Object.assign(new EventTarget(), { clientHeight: 600, clientWidth: 800 }) as unknown as HTMLElement,
	graph: (() => {
		const graph = new Graphraum(new FakeElement(800, 600) as unknown as HTMLElement, { mode });
		graphs.push(graph);
		return graph;
	})(),
});

const zoomIn = (graph: Graphraum) => {
	graph.setCameraState({ center: { x: 300, y: 300 }, mode: "2d", visibleHeight: 60 });
	(graph as unknown as { renderFrame(): void }).renderFrame();
};

const internals = (graph: Graphraum) =>
	graph as unknown as { data: { edges: GraphraumEdge[]; nodes: GraphraumNode[] } };

async function open(
	mode: "2d" | "3d",
	count: number,
	extra: Partial<OpenClusterLodOptions> = {},
): Promise<{ arrays: ReturnType<typeof arraysOf>; graph: Graphraum; lod: OpenedClusterLod }> {
	const arrays = arraysOf(count, mode === "2d" ? 2 : 3);
	const { element, graph } = view(mode);
	const lod = await openClusterLod(
		graph,
		{ ...arrays },
		{
			element,
			labels: false,
			maxDrawnEdges: 800,
			maxDrawnNodes: 300,
			...extra,
		},
	);
	opened.push(lod);
	return { arrays, graph, lod };
}

const modes: readonly [string, () => Partial<OpenClusterLodOptions>][] = [
	["a worker", () => ({ createWorker: () => inProcessWorker() })],
	["this thread", () => ({ worker: false })],
];

describe.each(modes)("openClusterLod with %s", (_name, options) => {
	test.each(["2d", "3d"] as const)("draws a bounded cut at once, then adds the aggregate edges in %s", async (mode) => {
		const { graph, lod } = await open(mode, 6000, options());
		const first = internals(graph).data;
		expect(first.nodes.length).toBeGreaterThan(0);
		expect(first.nodes.length).toBeLessThanOrEqual(300);
		// The first cut has no edges yet; they follow.
		expect(first.edges).toHaveLength(0);
		expect(lod.getTimings().completeMilliseconds).toBeNull();
		await lod.complete;
		expect(internals(graph).data.edges.length).toBeGreaterThan(0);
		expect(internals(graph).data.edges.length).toBeLessThanOrEqual(800);
		const timings = lod.getTimings();
		expect(timings.completeMilliseconds).toBeGreaterThanOrEqual(timings.firstCutMilliseconds);
		expect(timings.buildEdgesMilliseconds).not.toBeNull();
		expect(lod.usedWorker).toBe(_name === "a worker");
	});

	test.each(["2d", "3d"] as const)("draws the same cut as attaching a tree built from objects in %s", async (mode) => {
		const { arrays, graph, lod } = await open(mode, 6000, options());
		await lod.complete;
		const dimensions = mode === "2d" ? 2 : 3;
		const data = dataOf(arraysOf(6000, dimensions));
		const reference = view(mode);
		const tree = buildClusterTree({
			colors: nodeColorKeys(data.nodes),
			dimensions,
			edges: arraysOf(6000, dimensions).edges,
			positions: arraysOf(6000, dimensions).positions,
		});
		const handle = attachClusterLod(reference.graph, tree, {
			data,
			element: reference.element,
			labels: false,
			maxDrawnEdges: 800,
			maxDrawnNodes: 300,
		});
		opened.push(handle);
		const describeCut = (target: Graphraum) => ({
			edges: internals(target)
				.data.edges.map((edge) => [edge.id, edge.source, edge.target])
				.sort(),
			nodes: internals(target)
				.data.nodes.map((node) => [node.id, node.position.x, node.position.y, node.position.z ?? 0])
				.sort(),
		});
		expect(describeCut(graph)).toEqual(describeCut(reference.graph));
		expect(arrays.positions.byteLength).toBe(options().worker === false ? 6000 * dimensions * 4 : 0);
	});

	test("asks for the details of drawn nodes only, never the whole graph", async () => {
		const requested = new Set<number>();
		const node = vi.fn((index: number, arrays: OpenedClusterLod["arrays"]): GraphraumNode => {
			requested.add(index);
			return {
				id: `person-${index}`,
				label: `Person ${index}`,
				position: { x: arrays.positions[index * 2] as number, y: arrays.positions[index * 2 + 1] as number },
			} as GraphraumNode;
		});
		const { graph, lod } = await open("2d", 6000, { ...options(), node, transitionMilliseconds: 0 });
		await lod.complete;
		zoomIn(graph);
		expect(requested.size).toBeLessThanOrEqual(600);
		const real = internals(graph).data.nodes.find((entry) => entry.id.startsWith("person-"));
		expect(real).toBeDefined();
		expect((real as unknown as { label: string }).label).toMatch(/^Person /);
		const hit = lod.resolve(real?.id ?? "");
		expect(hit?.kind).toBe("node");
		if (hit?.kind === "node") expect(`person-${hit.node}`).toBe(real?.id);
	});

	test("keeps the whole graph in typed arrays and nothing per node", async () => {
		const { lod } = await open("3d", 6000, options());
		await lod.complete;
		for (const holder of [lod.tree, lod.arrays]) {
			for (const [key, value] of Object.entries(holder)) {
				const compact = value === null || value === undefined || typeof value !== "object" || ArrayBuffer.isView(value);
				expect(compact, `${key} holds a plain array or object`).toBe(true);
			}
		}
		expect(lod.members(0)).toHaveLength(6000);
		expect(lod.arrays.edges).toHaveLength(6000 * 2 * 2);
		expect(lod.arrays.positions).toBe(lod.tree.positions);
	});

	test("members, frameCluster and zoomToCluster keep working from the arrays", async () => {
		const { graph, lod } = await open("2d", 6000, { ...options(), transitionMilliseconds: 0, zoomMilliseconds: 0 });
		await lod.complete;
		const aggregate = internals(graph).data.nodes.find((node) => node.id.startsWith("cluster:"));
		const hit = lod.resolve(aggregate?.id ?? "");
		expect(hit?.kind).toBe("cluster");
		if (hit?.kind !== "cluster") return;
		expect(lod.members(hit.cluster)).toHaveLength(hit.count);
		expect(lod.frameCluster(hit.cluster).mode).toBe("2d");
		expect(await lod.zoomToCluster(hit.cluster)).toBe(true);
	});

	test("detach stops the worker and the layer, and settles complete", async () => {
		const log: string[] = [];
		const { graph, lod } = await open(
			"2d",
			6000,
			options().worker === false ? options() : { createWorker: () => inProcessWorker(log) },
		);
		const patch = vi.spyOn(graph, "applyDataPatch");
		lod.detach();
		await lod.complete;
		expect(patch).not.toHaveBeenCalled();
		if (options().worker !== false) expect(log).toContain("terminate");
	});
});

describe("openClusterLod errors", () => {
	test("rejects with the reason when the input is invalid", async () => {
		const { element, graph } = view("2d");
		await expect(
			openClusterLod(
				graph,
				{ dimensions: 2, positions: new Float32Array([0, Number.NaN]) },
				{ element, worker: false },
			),
		).rejects.toThrow("finite");
	});

	test("an aborted signal stops the open", async () => {
		const { element, graph } = view("2d");
		const controller = new AbortController();
		const log: string[] = [];
		const pending = openClusterLod(
			graph,
			{ ...arraysOf(2000, 2) },
			{
				createWorker: () => inProcessWorker(log),
				element,
				signal: controller.signal,
			},
		);
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(log).toContain("terminate");
		await expect(
			openClusterLod(graph, { ...arraysOf(2000, 2) }, { element, signal: controller.signal, worker: false }),
		).rejects.toThrow(/aborted/);
	});
});
