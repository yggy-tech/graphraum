import { describe, expect, test } from "vitest";

import { baseCoarseLevel, coarsenGraph, coarsenLevel, levelEdges } from "./graph-coarsen";
import { sparseRandomGraph } from "./test-support/layout-quality";

function star(leaves: number) {
	const edges = new Uint32Array(leaves * 2);
	for (let leaf = 0; leaf < leaves; leaf += 1) edges.set([0, leaf + 1], leaf * 2);
	return edges;
}

const parentOf = (level: ReturnType<typeof coarsenLevel>) => [...(level.parent as Uint32Array)];

describe("baseCoarseLevel", () => {
	test("drops self loops and edges that leave the node range", () => {
		const level = baseCoarseLevel(3, new Uint32Array([0, 0, 0, 1, 1, 9, 1, 2]));
		expect(level.col).toHaveLength(4);
		expect([...level.rowPtr]).toEqual([0, 1, 3, 4]);
		expect([...level.nodeWeight]).toEqual([1, 1, 1]);
	});
});

describe("coarsenLevel", () => {
	const graph = sparseRandomGraph(2_000, 3, 4);
	const finest = baseCoarseLevel(graph.nodeCount, graph.edges);

	test("maps every node to a dense coarse id and keeps the node weight", () => {
		const coarse = coarsenLevel(finest, 1);
		expect(coarse.parent).toHaveLength(finest.nodeCount);
		expect(Math.max(...parentOf(coarse))).toBe(coarse.nodeCount - 1);
		expect(coarse.nodeCount).toBeLessThan(finest.nodeCount * 0.8);
		expect([...coarse.nodeWeight].reduce((sum, weight) => sum + weight, 0)).toBe(finest.nodeCount);
	});

	test("keeps the weight of every edge that joins two groups, without parallel edges or loops", () => {
		const coarse = coarsenLevel(finest, 1);
		const parent = coarse.parent as Uint32Array;
		let between = 0;
		for (let node = 0; node < finest.nodeCount; node += 1) {
			for (let at = finest.rowPtr[node] ?? 0; at < (finest.rowPtr[node + 1] ?? 0); at += 1) {
				if (parent[node] !== parent[finest.col[at] ?? 0]) between += 1;
			}
		}
		expect([...coarse.weight].reduce((sum, weight) => sum + weight, 0)).toBe(between);
		const rows = new Set<string>();
		for (let node = 0; node < coarse.nodeCount; node += 1) {
			for (let at = coarse.rowPtr[node] ?? 0; at < (coarse.rowPtr[node + 1] ?? 0); at += 1) {
				const key = `${node}:${coarse.col[at]}`;
				expect(rows.has(key)).toBe(false);
				expect(coarse.col[at]).not.toBe(node);
				rows.add(key);
			}
		}
	});

	test("is deterministic for a seed and varies with it", () => {
		expect(parentOf(coarsenLevel(finest, 5))).toEqual(parentOf(coarsenLevel(finest, 5)));
		expect(parentOf(coarsenLevel(finest, 5))).not.toEqual(parentOf(coarsenLevel(finest, 6)));
	});

	test("folds the leaves of a hub into one group in a single level", () => {
		const coarse = coarsenLevel(baseCoarseLevel(101, star(100)), 0);
		expect(coarse.nodeCount).toBe(1);
		expect(coarse.nodeWeight[0]).toBe(101);
	});

	test("never merges nodes of different groups", () => {
		const groups = Uint32Array.from({ length: graph.nodeCount }, (_, node) => node % 3);
		const coarse = coarsenLevel(baseCoarseLevel(graph.nodeCount, graph.edges, groups), 2);
		const owner = new Map<number, number>();
		for (const [node, target] of parentOf(coarse).entries()) {
			const known = owner.get(target);
			if (known !== undefined) expect(known).toBe(groups[node]);
			owner.set(target, groups[node] ?? 0);
		}
		expect(coarse.groups).toHaveLength(coarse.nodeCount);
	});
});

describe("coarsenGraph", () => {
	const graph = sparseRandomGraph(5_000, 4, 4);
	const finest = baseCoarseLevel(graph.nodeCount, graph.edges);

	test("reaches the coarsest size", () => {
		const levels = coarsenGraph(finest, { coarsestSize: 100, maxLevels: 32 });
		expect(levels[0]).toBe(finest);
		expect(levels.at(-1)?.nodeCount).toBeLessThanOrEqual(100);
	});

	test("respects the level cap", () => {
		expect(coarsenGraph(finest, { coarsestSize: 100, maxLevels: 2 })).toHaveLength(3);
	});

	test("stops when a level removes too few nodes", () => {
		expect(coarsenGraph(baseCoarseLevel(500, new Uint32Array()), { coarsestSize: 8, maxLevels: 32 })).toHaveLength(1);
	});
});

describe("levelEdges", () => {
	test("lists each edge once with its weight", () => {
		const { edges, weights } = levelEdges(baseCoarseLevel(3, new Uint32Array([0, 1, 1, 2])));
		expect([...edges]).toEqual([0, 1, 1, 2]);
		expect([...weights]).toEqual([1, 1]);
	});
});
