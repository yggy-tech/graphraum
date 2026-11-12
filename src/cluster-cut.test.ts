import { describe, expect, test } from "vitest";
import { type ClusterCut, type ClusterView, createClusterCutter } from "./cluster-cut";
import { buildClusterTree } from "./cluster-tree";
import { randomEdges, scatter } from "./test-support/cluster-fixtures";

const SIZE = { height: 600, width: 800 };
const whole2d: ClusterView = { ...SIZE, center: { x: 500, y: 500 }, mode: "2d", visibleHeight: 1100 };
const whole3d: ClusterView = {
	...SIZE,
	mode: "3d",
	position: { x: 500, y: 500, z: 2600 },
	target: { x: 500, y: 500, z: 500 },
};

/** Every node must be inside exactly one cut element: a cluster's range or a drawn real node. */
function coveredNodes(tree: ReturnType<typeof buildClusterTree>, cut: ClusterCut) {
	const covered = new Uint8Array(tree.nodeCount);
	for (const cluster of cut.clusters) {
		const start = tree.memberStart[cluster] as number;
		for (let rank = start; rank < start + (tree.memberCount[cluster] as number); rank += 1) {
			const node = tree.order[rank] as number;
			covered[node] = (covered[node] ?? 0) + 1;
		}
	}
	for (const node of cut.nodes) covered[node] = (covered[node] ?? 0) + 1;
	return covered;
}

describe.each([
	[2, whole2d],
	[3, whole3d],
] as const)("cluster cut in %iD", (dimensions, view) => {
	test.each([10_000, 100_000])("stays within the budget for %i nodes and covers every node once", (count) => {
		const tree = buildClusterTree({
			dimensions,
			edges: randomEdges(count, count * 2),
			positions: scatter(count, dimensions),
		});
		const cut = createClusterCutter(tree)(view, { cullMargin: 10, maxDrawnEdges: 2000, maxDrawnNodes: 1500 });
		expect(cut.clusters.length + cut.nodes.length).toBeLessThanOrEqual(1500);
		expect(cut.edgeWeight.length).toBeLessThanOrEqual(2000);
		expect(cut.clusters.length).toBeGreaterThan(100);
		// A huge margin turns culling off: the cut then partitions all nodes.
		expect(coveredNodes(tree, cut).every((times) => times === 1)).toBe(true);
	});

	test("represents every occupied region of the view", () => {
		const count = 20_000;
		const positions = scatter(count, dimensions);
		const tree = buildClusterTree({ dimensions, positions });
		const cut = createClusterCutter(tree)(view, { cullMargin: 10, maxDrawnNodes: 1000 });
		const covered = coveredNodes(tree, cut);
		// Each node of a 10x10 grid of cells (by x, y) lies in some drawn element.
		for (let node = 0; node < count; node += 1) expect(covered[node]).toBe(1);
	});

	test("edge ends are cut elements and weights are positive", () => {
		const tree = buildClusterTree({
			dimensions,
			edges: randomEdges(5000, 15_000),
			positions: scatter(5000, dimensions),
		});
		const cut = createClusterCutter(tree)(view, { cullMargin: 10, maxDrawnNodes: 800 });
		const elements = cut.clusters.length + cut.nodes.length;
		expect(cut.edgeWeight.length).toBeGreaterThan(0);
		for (let edge = 0; edge < cut.edgeWeight.length; edge += 1) {
			expect(cut.edgeSource[edge]).toBeLessThan(elements);
			expect(cut.edgeTarget[edge]).toBeLessThan(elements);
			expect(cut.edgeSource[edge]).not.toBe(cut.edgeTarget[edge]);
			expect(cut.edgeWeight[edge]).toBeGreaterThan(0);
		}
	});
});

describe("aggregated edge weights", () => {
	test("equal the number of edges between the covered nodes when nothing is dropped", () => {
		const count = 600;
		const edges = randomEdges(count, 1800);
		const tree = buildClusterTree({ dimensions: 2, edges, maxNeighbors: 10_000, positions: scatter(count, 2) });
		const cut = createClusterCutter(tree)(whole2d, {
			cullMargin: 10,
			maxDrawnEdges: 100_000,
			maxDrawnNodes: 120,
			pixelThreshold: 4,
		});
		// Which cut element holds each node.
		const holder = new Int32Array(count).fill(-1);
		for (const [element, cluster] of cut.clusters.entries()) {
			const start = tree.memberStart[cluster] as number;
			for (let rank = start; rank < start + (tree.memberCount[cluster] as number); rank += 1)
				holder[tree.order[rank] as number] = element;
		}
		for (const [position, node] of cut.nodes.entries()) holder[node] = cut.clusters.length + position;
		const expected = new Map<string, number>();
		for (let edge = 0; edge < count * 3; edge += 1) {
			const left = holder[edges[edge * 2] as number] as number;
			const right = holder[edges[edge * 2 + 1] as number] as number;
			if (left === right) continue;
			const key = left < right ? `${left}:${right}` : `${right}:${left}`;
			expected.set(key, (expected.get(key) ?? 0) + 1);
		}
		const got = new Map<string, number>();
		for (let edge = 0; edge < cut.edgeWeight.length; edge += 1) {
			const left = cut.edgeSource[edge] as number;
			const right = cut.edgeTarget[edge] as number;
			const key = left < right ? `${left}:${right}` : `${right}:${left}`;
			got.set(key, (got.get(key) ?? 0) + (cut.edgeWeight[edge] as number));
		}
		// Real edges are drawn one by one; aggregate pairs sum. Both add up to the edges between holders.
		expect(got.size).toBe(expected.size);
		for (const [key, weight] of expected) expect(got.get(key)).toBeCloseTo(weight, 3);
		expect(cut.nodes.length).toBeGreaterThan(0);
	});
});

describe("screen-space error", () => {
	const count = 20_000;
	const tree = buildClusterTree({ dimensions: 2, positions: scatter(count, 2) });
	const cutter = createClusterCutter(tree);

	test("zooming in shows deeper clusters and real nodes", () => {
		const far = cutter(whole2d, { maxDrawnNodes: 3000 });
		const near = cutter({ ...whole2d, center: { x: 500, y: 500 }, visibleHeight: 200 }, { maxDrawnNodes: 3000 });
		expect(near.nodes.length).toBeGreaterThan(0);
		expect(near.nodes.length).toBeGreaterThan(far.nodes.length);
	});

	test("a larger threshold makes a coarser cut", () => {
		const fine = cutter(whole2d, { maxDrawnNodes: 3000, pixelThreshold: 4 });
		const coarse = cutter(whole2d, { maxDrawnNodes: 3000, pixelThreshold: 40 });
		expect(coarse.clusters.length).toBeLessThan(fine.clusters.length);
	});

	test("clusters off screen are left out", () => {
		const cut = cutter({ ...whole2d, center: { x: 5000, y: 5000 }, visibleHeight: 100 }, { maxDrawnNodes: 3000 });
		expect(cut.clusters.length + cut.nodes.length).toBe(0);
	});

	test("a 3D camera inside the data still gets a bounded cut", () => {
		const tree3 = buildClusterTree({ dimensions: 3, positions: scatter(20_000, 3) });
		const cut = createClusterCutter(tree3)(
			{ ...SIZE, mode: "3d", position: { x: 500, y: 500, z: 500 }, target: { x: 500, y: 500, z: 0 } },
			{ maxDrawnNodes: 1000 },
		);
		expect(cut.clusters.length + cut.nodes.length).toBeLessThanOrEqual(1000);
		expect(cut.clusters.length + cut.nodes.length).toBeGreaterThan(0);
	});

	test("rejects a view of the wrong dimension and bad options", () => {
		expect(() => cutter(whole3d)).toThrow(/2D cluster tree/);
		expect(() => cutter(whole2d, { pixelThreshold: 0 })).toThrow(/pixelThreshold/);
		expect(() => cutter(whole2d, { maxDrawnNodes: 0 })).toThrow(/maxDrawnNodes/);
	});
});

describe("1M nodes", () => {
	test("a cut of a million nodes stays bounded in 3D and shows every region", () => {
		const count = 1_000_000;
		const positions = scatter(count, 3, 9);
		const tree = buildClusterTree({ dimensions: 3, leafSize: 32, positions });
		const cut = createClusterCutter(tree)(whole3d, { cullMargin: 10, maxDrawnNodes: 4000 });
		expect(cut.clusters.length + cut.nodes.length).toBeLessThanOrEqual(4000);
		expect(coveredNodes(tree, cut).every((times) => times === 1)).toBe(true);
	}, 60_000);
});
