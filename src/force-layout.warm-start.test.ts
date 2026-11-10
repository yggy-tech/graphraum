import { describe, expect, test } from "vitest";

import {
	computeForcePositions,
	createForceSimulation,
	DEFAULT_FORCE_SETTINGS,
	type ForceAnchors,
	type ForceLayoutStyle,
} from "./force-layout";
import { placeNewNodes } from "./layout-start";
import { documentBlockModel, seededRandom } from "./test-support/layout-quality";

const LINK = DEFAULT_FORCE_SETTINGS.linkDistance;
const AXES = [0, 1, 2];

function median(values: number[]) {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** A neighbour of `node` (itself when isolated), so a new node links two nodes that sit close together. */
function neighbourOf(edges: Uint32Array, node: number) {
	for (let index = 0; index < edges.length; index += 2) {
		if (edges[index] === node) return edges[index + 1] ?? node;
		if (edges[index + 1] === node) return edges[index] ?? node;
	}
	return node;
}

/** The base graph plus about 5% new nodes, each linked to a random old node and one of its neighbours. */
function grow(style: ForceLayoutStyle, dimensions: 2 | 3, withClusters: boolean) {
	const graph = documentBlockModel();
	const settings = { ...DEFAULT_FORCE_SETTINGS, layoutStyle: style };
	const clusters = withClusters ? graph.groups : undefined;
	const settled = computeForcePositions({
		clusters,
		dimensions,
		edges: graph.edges,
		nodeCount: graph.nodeCount,
		settings,
	});
	const random = seededRandom(5);
	const nodeCount = graph.nodeCount + Math.ceil(graph.nodeCount * 0.05);
	const extra: number[] = [];
	const nextClusters = clusters ? new Uint32Array(nodeCount) : undefined;
	nextClusters?.set(graph.groups);
	for (let node = graph.nodeCount; node < nodeCount; node += 1) {
		const first = Math.floor(random() * graph.nodeCount);
		extra.push(node, first, node, neighbourOf(graph.edges, first));
		if (nextClusters) nextClusters[node] = graph.groups[first] ?? 0;
	}
	const edges = Uint32Array.from([...graph.edges, ...extra]);
	const initialPositions = new Float32Array(nodeCount * 3).fill(Number.NaN);
	initialPositions.set(settled);
	const placed = placeNewNodes({ clusters: nextClusters, dimensions, edges, nodeCount }, initialPositions);
	return { dimensions, edges, graph, initialPositions: placed, nextClusters, nodeCount, settings, settled };
}

/** Positions are re-centred each step, so remove the shared shift before comparing. */
function displacements(grown: ReturnType<typeof grow>, next: Float32Array) {
	const { graph, settled } = grown;
	const delta = (node: number, axis: number) => (next[node * 3 + axis] ?? 0) - (settled[node * 3 + axis] ?? 0);
	const shift = AXES.map(
		(axis) =>
			Array.from({ length: graph.nodeCount }, (_, node) => delta(node, axis)).reduce((a, b) => a + b, 0) /
			graph.nodeCount,
	);
	return Array.from({ length: graph.nodeCount }, (_, node) =>
		Math.hypot(...AXES.map((axis) => delta(node, axis) - (shift[axis] ?? 0))),
	);
}

describe("warm start", () => {
	for (const style of ["classic", "edge-t"] as const) {
		for (const withClusters of [false, true]) {
			test(`adding 5% nodes barely moves settled nodes (${style}${withClusters ? ", clusters" : ""})`, () => {
				const grown = grow(style, 3, withClusters);
				const request = {
					clusters: grown.nextClusters,
					dimensions: 3 as const,
					edges: grown.edges,
					nodeCount: grown.nodeCount,
					settings: grown.settings,
				};
				const warm = computeForcePositions({
					...request,
					initialPositions: grown.initialPositions,
					warmStart: true,
				});
				const warmMedian = median(displacements(grown, warm));
				expect(warmMedian).toBeLessThan(LINK * 0.25);
				// A cold start moves nodes far more: the reuse is what keeps them put.
				expect(warmMedian).toBeLessThan(median(displacements(grown, computeForcePositions(request))) / 2);
			});
		}
	}

	test("places new nodes near their neighbours", () => {
		const grown = grow("classic", 2, false);
		const next = computeForcePositions({
			dimensions: 2,
			edges: grown.edges,
			initialPositions: grown.initialPositions,
			nodeCount: grown.nodeCount,
			settings: grown.settings,
			warmStart: true,
		});
		const distances: number[] = [];
		for (let index = 0; index < grown.edges.length; index += 2) {
			const a = grown.edges[index] ?? 0;
			const b = grown.edges[index + 1] ?? 0;
			if (a < grown.graph.nodeCount) continue;
			distances.push(
				Math.hypot((next[a * 3] ?? 0) - (next[b * 3] ?? 0), (next[a * 3 + 1] ?? 0) - (next[b * 3 + 1] ?? 0)),
			);
		}
		expect(median(distances)).toBeLessThan(LINK * 2);
	});

	test("placeNewNodes puts a new node next to its placed neighbour", () => {
		const nan = Number.NaN;
		const request = { dimensions: 2 as const, edges: new Uint32Array([0, 1, 1, 2]), nodeCount: 3 };
		const simulation = createForceSimulation({
			...request,
			initialPositions: placeNewNodes(request, new Float32Array([100, 0, 0, nan, nan, nan, nan, nan, nan])),
			warmStart: true,
		});
		const distance = (node: number) =>
			Math.hypot((simulation.positions[node * 3] ?? 0) - 100, simulation.positions[node * 3 + 1] ?? 0);
		expect(distance(1)).toBeLessThan(LINK);
		expect(distance(2)).toBeLessThan(LINK * 2);
		expect(simulation.positions[2]).toBe(0);
		expect(simulation.positions[0]).toBe(100);
	});

	test("placeNewNodes falls back to the cluster mean for a node without neighbours", () => {
		const nan = Number.NaN;
		const request = {
			clusters: new Uint32Array([0, 0, 1, 0]),
			dimensions: 2 as const,
			edges: new Uint32Array(),
			nodeCount: 4,
		};
		const simulation = createForceSimulation({
			...request,
			initialPositions: placeNewNodes(request, new Float32Array([200, 0, 0, 220, 0, 0, -200, 0, 0, nan, nan, nan])),
			warmStart: true,
		});
		expect(Math.abs((simulation.positions[9] ?? 0) - 210)).toBeLessThan(LINK);
	});

	test("keeps placed anchored nodes where they were and seeds new anchored nodes at the anchor", () => {
		const anchors: ForceAnchors = { positions: new Float32Array([-1, 0, 1, 0, 0, 1]) };
		const nan = Number.NaN;
		const simulation = createForceSimulation({
			anchors,
			dimensions: 2,
			edges: new Uint32Array(),
			initialPositions: new Float32Array([500, 500, 0, 600, 600, 0, nan, nan, nan]),
			nodeCount: 3,
			warmStart: true,
		});
		expect(simulation.positions[0]).toBe(500);
		expect(simulation.positions[3]).toBe(600);
		expect(Math.abs(simulation.positions[7] ?? 0)).toBeGreaterThan(1);
	});
});
