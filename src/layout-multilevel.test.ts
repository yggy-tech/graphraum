import { describe, expect, test } from "vitest";

import { computeForcePositions, DEFAULT_FORCE_SETTINGS, type ForceLayoutRequest } from "./force-layout";
import { computeMultilevelForcePositions, type MultilevelProgress } from "./layout-multilevel";
import {
	documentBlockModel,
	measureLayout,
	type QualityGraph,
	sampledLayoutQuality,
	sparseRandomGraph,
} from "./test-support/layout-quality";

const graph = sparseRandomGraph(3_000, 5, 4);
const options = { coarsestSize: 100 };

function request(source: QualityGraph, patch: Partial<ForceLayoutRequest> = {}): ForceLayoutRequest {
	return { dimensions: 2, edges: source.edges, nodeCount: source.nodeCount, ...patch };
}

function expectPositioned(positions: Float32Array, nodeCount: number, dimensions: 2 | 3) {
	expect(positions).toHaveLength(nodeCount * 3);
	for (const value of positions) expect(Number.isFinite(value)).toBe(true);
	if (dimensions === 2) for (let node = 0; node < nodeCount; node += 1) expect(positions[node * 3 + 2]).toBe(0);
}

describe("computeMultilevelForcePositions", () => {
	test.each([
		["classic", 2],
		["classic", 3],
		["edge-t", 2],
		["edge-t", 3],
	] as const)("positions every node in the %s style in %sD", (layoutStyle, dimensions) => {
		const positions = computeMultilevelForcePositions(
			request(graph, { dimensions, settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle } }),
			options,
		);
		expectPositioned(positions, graph.nodeCount, dimensions);
		const spread = new Set(Array.from({ length: graph.nodeCount }, (_, node) => Math.round(positions[node * 3] ?? 0)));
		expect(spread.size).toBeGreaterThan(100);
	});

	test("is deterministic for a seed and changes with it", () => {
		const first = computeMultilevelForcePositions(request(graph), { ...options, seed: 3 });
		expect([...computeMultilevelForcePositions(request(graph), { ...options, seed: 3 })]).toEqual([...first]);
		expect([...computeMultilevelForcePositions(request(graph), { ...options, seed: 4 })]).not.toEqual([...first]);
	});

	test("does not change its input", () => {
		const edges = graph.edges.slice();
		const initialPositions = new Float32Array(graph.nodeCount * 3).fill(1);
		const before = initialPositions.slice();
		computeMultilevelForcePositions(request(graph, { initialPositions }), options);
		expect([...graph.edges]).toEqual([...edges]);
		expect([...initialPositions]).toEqual([...before]);
	});

	test("lays out a graph no larger than the coarsest size like the plain force layout", () => {
		const small = sparseRandomGraph(150, 2, 3);
		expect([...computeMultilevelForcePositions(request(small))]).toEqual([...computeForcePositions(request(small))]);
	});

	test("falls back to the plain force layout when nothing can be merged", () => {
		const isolated = { edges: new Uint32Array(), groups: new Uint32Array(500), name: "isolated", nodeCount: 500 };
		const positions = computeMultilevelForcePositions(request(isolated), options);
		expect([...positions]).toEqual([...computeForcePositions(request(isolated))]);
	});

	test("handles an empty graph and a graph without edges", () => {
		expect(computeMultilevelForcePositions({ dimensions: 2, edges: new Uint32Array(), nodeCount: 0 })).toHaveLength(0);
		const loose = computeMultilevelForcePositions({ dimensions: 3, edges: new Uint32Array(), nodeCount: 400 }, options);
		expectPositioned(loose, 400, 3);
	});

	test("settles from known positions like the plain force layout when warmStart is set", () => {
		const settled = computeMultilevelForcePositions(request(graph), options);
		const warm = request(graph, { initialPositions: settled, warmStart: true });
		const next = computeMultilevelForcePositions(warm, options);
		expect([...next]).toEqual([...computeForcePositions(warm)]);
		let moved = 0;
		for (let index = 0; index < settled.length; index += 1)
			moved = Math.max(moved, Math.abs((next[index] ?? 0) - (settled[index] ?? 0)));
		expect(moved).toBeLessThan(5);
	});

	test("keeps new nodes of a warm start finite", () => {
		const settled = computeMultilevelForcePositions(request(graph), options);
		const start = settled.slice();
		start.fill(Number.NaN, 0, 30);
		const next = computeMultilevelForcePositions(request(graph, { initialPositions: start, warmStart: true }), options);
		expectPositioned(next, graph.nodeCount, 2);
	});

	test("starts the coarse layout from the positions it is given", () => {
		const planted = new Float32Array(graph.nodeCount * 3);
		for (let node = 0; node < graph.nodeCount; node += 1) {
			planted[node * 3] = node < 1_500 ? -400 : 400;
			planted[node * 3 + 1] = (node % 50) * 4;
		}
		const positions = computeMultilevelForcePositions(request(graph, { initialPositions: planted }), options);
		expectPositioned(positions, graph.nodeCount, 2);
		const mean = (from: number, to: number) => {
			let sum = 0;
			for (let node = from; node < to; node += 1) sum += positions[node * 3] ?? 0;
			return sum / (to - from);
		};
		expect(mean(0, 1_500)).toBeLessThan(mean(1_500, 3_000));
	});

	test("pulls nodes towards anchors", () => {
		const anchors = new Float32Array(graph.nodeCount * 2);
		for (let node = 0; node < graph.nodeCount; node += 1) anchors[node * 2] = node < 1_500 ? -1 : 1;
		const positions = computeMultilevelForcePositions(
			request(graph, {
				anchors: { positions: anchors, strength: 4 },
				settings: { ...DEFAULT_FORCE_SETTINGS, anchorStrength: 0.1 },
			}),
			options,
		);
		expectPositioned(positions, graph.nodeCount, 2);
		const meanX = (from: number, to: number) => {
			let sum = 0;
			for (let node = from; node < to; node += 1) sum += positions[node * 3] ?? 0;
			return sum / (to - from);
		};
		expect(meanX(0, 1_500)).toBeLessThan(meanX(1_500, 3_000));
	});

	test("keeps clusters apart and never merges across them", () => {
		const blocks = documentBlockModel(191, [400, 300, 250, 200, 150, 100]);
		const positions = computeMultilevelForcePositions(request(blocks, { clusters: blocks.groups }), {
			coarsestSize: 24,
		});
		expectPositioned(positions, blocks.nodeCount, 2);
		expect(measureLayout(blocks, positions).silhouette).toBeGreaterThan(0.5);
	});

	test("reports the phases and gives one preview before the refinement", () => {
		const events: MultilevelProgress[] = [];
		const previews: Float32Array[] = [];
		const positions = computeMultilevelForcePositions(request(graph), {
			...options,
			onPreview: (preview) => {
				previews.push(preview);
				expect(events.map((event) => event.phase)).toEqual(["coarsen", "coarsest"]);
			},
			onProgress: (event) => events.push(event),
		});
		expect(previews).toHaveLength(1);
		expectPositioned(previews[0] as Float32Array, graph.nodeCount, 2);
		expect(previews[0]).not.toBe(positions);
		expect(events[0]?.phase).toBe("coarsen");
		expect(events[1]?.phase).toBe("coarsest");
		expect(events.slice(2).every((event) => event.phase === "refine")).toBe(true);
		expect(events.at(-1)?.level).toBe(0);
		expect(events.at(-1)?.nodeCount).toBe(graph.nodeCount);
		expect(events[1]?.nodeCount).toBeLessThanOrEqual(100);
	});

	test("honours levels", () => {
		const events: MultilevelProgress[] = [];
		computeMultilevelForcePositions(request(graph), {
			...options,
			levels: 1,
			onProgress: (event) => events.push(event),
		});
		expect(events.map((event) => `${event.phase}${event.level}`)).toEqual(["coarsen1", "coarsest1", "refine0"]);
	});

	test.each([
		[{ coarsestSize: 4 }, /coarsestSize/],
		[{ coarsestSize: 1.5 }, /coarsestSize/],
		[{ levels: 0 }, /levels/],
		[{ refineSteps: 17 }, /refineSteps/],
		[{ seed: -1 }, /seed/],
	])("rejects the option %j", (bad, message) => {
		expect(() => computeMultilevelForcePositions(request(graph), bad)).toThrow(message);
	});

	test("rejects an odd edge list", () => {
		expect(() => computeMultilevelForcePositions({ dimensions: 2, edges: new Uint32Array(3), nodeCount: 500 })).toThrow(
			/pairs/,
		);
	});
});

describe("quality against the plain force layout", () => {
	test("keeps the stress of a sparse random graph close", () => {
		const big = sparseRandomGraph(6_000, 7, 6);
		const plain = sampledLayoutQuality(big, computeForcePositions(request(big)), 8);
		const multilevel = sampledLayoutQuality(big, computeMultilevelForcePositions(request(big)), 8);
		expect(multilevel.stress).toBeLessThan(plain.stress * 1.3);
	});
});
