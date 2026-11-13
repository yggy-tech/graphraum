import { beforeAll, describe, expect, test } from "vitest";

import { computeForcePositions, type ForceLayoutRequest } from "./force-layout";
import { computeMultilevelForcePositions } from "./layout-multilevel";
import { sparseRandomGraph } from "./test-support/layout-quality";

const graph = sparseRandomGraph(3_000, 5, 4);
const options = { coarsestSize: 100 };
let settled: Float32Array;

beforeAll(() => {
	settled = computeMultilevelForcePositions({ dimensions: 2, edges: graph.edges, nodeCount: 3_000 }, options);
});

function warm(patch: Partial<ForceLayoutRequest>, previous?: Parameters<typeof computeMultilevelForcePositions>[1]) {
	return computeMultilevelForcePositions(
		{
			dimensions: 2,
			edges: graph.edges,
			initialPositions: settled.slice(),
			nodeCount: 3_000,
			warmStart: true,
			...patch,
		},
		{ ...options, ...previous },
	);
}

/** Nodes within `hops` of any of `seeds` over `edges`. */
function within(edges: Uint32Array, seeds: number[], hops: number) {
	const reached = new Set(seeds);
	let frontier = seeds;
	for (let hop = 0; hop < hops; hop += 1) {
		const next: number[] = [];
		for (let index = 0; index < edges.length; index += 2) {
			const source = edges[index] ?? 0;
			const target = edges[index + 1] ?? 0;
			if (frontier.includes(source) && !reached.has(target)) next.push(target);
			if (frontier.includes(target) && !reached.has(source)) next.push(source);
		}
		for (const node of next) reached.add(node);
		frontier = next;
	}
	return reached;
}

function moved(next: Float32Array, nodes = 3_000) {
	const result = new Set<number>();
	for (let node = 0; node < nodes; node += 1) {
		for (let axis = 0; axis < 3; axis += 1) {
			if (next[node * 3 + axis] !== settled[node * 3 + axis]) result.add(node);
		}
	}
	return result;
}

describe("warm start of the changed part", () => {
	test("settles new nodes and their neighbourhood and leaves every other node exactly where it was", () => {
		const start = settled.slice();
		const fresh = [10, 11, 12];
		for (const node of fresh) start.fill(Number.NaN, node * 3, node * 3 + 3);
		const next = warm({ initialPositions: start });
		const reach = within(graph.edges, fresh, 2);
		const changed = moved(next);
		expect(changed.size).toBeGreaterThan(0);
		for (const node of changed) expect(reach.has(node)).toBe(true);
		for (let node = 0; node < 3_000; node += 1) {
			for (let axis = 0; axis < 3; axis += 1) expect(Number.isFinite(next[node * 3 + axis])).toBe(true);
		}
	});

	test("starts a new node near its placed neighbours instead of at a random place", () => {
		const start = settled.slice();
		const node = 700;
		start.fill(Number.NaN, node * 3, node * 3 + 3);
		const neighbours: number[] = [];
		for (let index = 0; index < graph.edges.length; index += 2) {
			if (graph.edges[index] === node) neighbours.push(graph.edges[index + 1] ?? 0);
			if (graph.edges[index + 1] === node) neighbours.push(graph.edges[index] ?? 0);
		}
		expect(neighbours.length).toBeGreaterThan(0);
		const next = warm({ initialPositions: start });
		const mean = [0, 1].map(
			(axis) => neighbours.reduce((sum, id) => sum + (settled[id * 3 + axis] ?? 0), 0) / neighbours.length,
		);
		const distance = Math.hypot((next[node * 3] ?? 0) - (mean[0] ?? 0), (next[node * 3 + 1] ?? 0) - (mean[1] ?? 0));
		const extent = Math.hypot(
			...[0, 1].map((axis) =>
				Math.max(...Array.from({ length: 3_000 }, (_, id) => Math.abs(settled[id * 3 + axis] ?? 0))),
			),
		);
		expect(distance).toBeLessThan(extent * 0.1);
	});

	test("refines only the ends of a removed edge and their neighbourhoods when given the previous graph", () => {
		const removed = [0, 1, 2, 3].map((edge) => edge * 2);
		const edges = graph.edges.filter((_, index) => !removed.some((start) => index === start || index === start + 1));
		const next = warm({ edges }, { previous: { edges: graph.edges, nodeCount: 3_000 } });
		const ends = removed.flatMap((start) => [graph.edges[start] ?? 0, graph.edges[start + 1] ?? 0]);
		const reach = within(edges, ends, 2);
		const changed = moved(next);
		expect(changed.size).toBeGreaterThan(0);
		for (const node of changed) expect(reach.has(node)).toBe(true);
	});

	test("refines the nodes of an added edge and treats nodes past the previous count as new", () => {
		const edges = new Uint32Array([...graph.edges, 5, 2_500, 2_999, 2_998]);
		const next = warm({ edges }, { previous: { edges: graph.edges, nodeCount: 2_999 } });
		const reach = within(edges, [5, 2_500, 2_999, 2_998], 2);
		const changed = moved(next);
		for (const node of changed) expect(reach.has(node)).toBe(true);
		expect(changed.has(2_999)).toBe(true);
	});

	test("refines only nodes whose anchor moved", () => {
		const anchors = new Float32Array(3_000 * 2);
		for (let node = 0; node < 3_000; node += 1) anchors[node * 2] = node % 7;
		const movedAnchors = anchors.slice();
		for (const node of [40, 41]) movedAnchors[node * 2] += 30;
		const next = warm(
			{ anchors: { positions: movedAnchors } },
			{ previous: { anchors: { positions: anchors }, edges: graph.edges, nodeCount: 3_000 } },
		);
		const reach = within(graph.edges, [40, 41], 2);
		const changed = moved(next);
		expect(changed.size).toBeGreaterThan(0);
		for (const node of changed) expect(reach.has(node)).toBe(true);
	});

	test("returns the positions unchanged when nothing changed", () => {
		const next = warm({}, { previous: { edges: graph.edges, nodeCount: 3_000 } });
		expect([...next]).toEqual([...settled]);
	});

	test("settles the whole graph when most of it changed, like the plain warm start", () => {
		const start = settled.slice();
		for (let node = 0; node < 2_400; node += 1) start.fill(Number.NaN, node * 3, node * 3 + 3);
		const next = warm({ initialPositions: start });
		for (const value of next) expect(Number.isFinite(value)).toBe(true);
		expect(moved(next).size).toBeGreaterThan(2_000);
	});

	test("is deterministic and does not change its input", () => {
		const start = settled.slice();
		start.fill(Number.NaN, 30, 36);
		const copy = start.slice();
		const first = warm({ initialPositions: start });
		expect([...warm({ initialPositions: start })]).toEqual([...first]);
		expect([...start].map(String)).toEqual([...copy].map(String));
	});

	test("settles a graph without a previous layout and without new nodes like the plain warm start", () => {
		const request = {
			dimensions: 2 as const,
			edges: graph.edges,
			initialPositions: settled.slice(),
			nodeCount: 3_000,
			warmStart: true,
		};
		expect([...computeMultilevelForcePositions(request, options)]).toEqual([...computeForcePositions(request)]);
	});
});
