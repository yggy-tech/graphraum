import { describe, expect, test } from "vitest";
import { createClusterCutter } from "./cluster-cut";
import { buildClusterTree, clusterMembers, clusterTreeTransferables, startClusterTree } from "./cluster-tree";
import { randomEdges, scatter } from "./test-support/cluster-fixtures";

describe.each([2, 3] as const)("cluster tree in %iD", (dimensions) => {
	const count = 3000;
	const positions = scatter(count, dimensions);
	const tree = buildClusterTree({ dimensions, edges: randomEdges(count, 9000), positions });

	test("puts every node in exactly one leaf", () => {
		const seen = new Uint8Array(count);
		let leaves = 0;
		for (let cluster = 0; cluster < tree.clusterCount; cluster += 1) {
			if (tree.childCount[cluster] !== 0) continue;
			leaves += 1;
			for (const node of clusterMembers(tree, cluster)) {
				seen[node] = (seen[node] ?? 0) + 1;
				expect(tree.leafOf[node]).toBe(cluster);
			}
		}
		expect(leaves).toBeGreaterThan(1);
		expect(seen.every((times) => times === 1)).toBe(true);
	});

	test("counts and centroids add up from members", () => {
		for (let cluster = 0; cluster < tree.clusterCount; cluster += 1) {
			const members = clusterMembers(tree, cluster);
			expect(members.length).toBe(tree.memberCount[cluster]);
			const mean = Array.from(
				{ length: dimensions },
				(_, axis) =>
					members.reduce((sum, node) => sum + (positions[node * dimensions + axis] as number), 0) / members.length,
			);
			for (let axis = 0; axis < dimensions; axis += 1) {
				expect(tree.centroid[cluster * dimensions + axis]).toBeCloseTo(mean[axis] as number, 2);
			}
			for (const node of members) {
				const distance = Math.hypot(
					...Array.from(
						{ length: dimensions },
						(_, axis) =>
							(positions[node * dimensions + axis] as number) - (tree.centroid[cluster * dimensions + axis] as number),
					),
				);
				expect(distance).toBeLessThanOrEqual((tree.radius[cluster] as number) + 1e-2);
			}
		}
		expect(tree.memberCount[0]).toBe(count);
	});

	test("children partition their parent", () => {
		for (let cluster = 0; cluster < tree.clusterCount; cluster += 1) {
			const childCount = tree.childCount[cluster] as number;
			if (childCount === 0) continue;
			const first = tree.childStart[cluster] as number;
			let total = 0;
			for (let child = first; child < first + childCount; child += 1) {
				expect(tree.parent[child]).toBe(cluster);
				expect(tree.depth[child]).toBe((tree.depth[cluster] as number) + 1);
				total += tree.memberCount[child] as number;
			}
			expect(total).toBe(tree.memberCount[cluster]);
		}
	});

	test("small leaves unless nodes coincide", () => {
		for (let cluster = 0; cluster < tree.clusterCount; cluster += 1) {
			if (tree.childCount[cluster] === 0) expect(tree.memberCount[cluster]).toBeLessThanOrEqual(tree.leafSize);
		}
	});
});

describe("aggregated edges", () => {
	test("conserve the weight between leaves", () => {
		const count = 500;
		const edges = randomEdges(count, 1500);
		const weights = Float32Array.from({ length: 1500 }, (_, index) => 1 + (index % 3));
		const tree = buildClusterTree({
			dimensions: 2,
			edges,
			maxNeighbors: 10_000,
			positions: scatter(count, 2),
			weights,
		});
		let expected = 0;
		for (let edge = 0; edge < 1500; edge += 1) {
			const source = edges[edge * 2] as number;
			const target = edges[edge * 2 + 1] as number;
			if (tree.leafOf[source] !== tree.leafOf[target]) expected += 2 * (weights[edge] as number);
		}
		let leafTotal = 0;
		for (let cluster = 0; cluster < tree.clusterCount; cluster += 1) {
			if (tree.childCount[cluster] !== 0) continue;
			for (let slot = 0; slot < (tree.adjacencyCount[cluster] as number); slot += 1) {
				leafTotal += tree.adjacencyWeight[(tree.adjacencyStart[cluster] as number) + slot] as number;
			}
		}
		expect(leafTotal).toBeCloseTo(expected, 3);
	});

	test("a parent never lists itself or a descendant", () => {
		const tree = buildClusterTree({ dimensions: 3, edges: randomEdges(800, 2400), positions: scatter(800, 3) });
		for (let cluster = 0; cluster < tree.clusterCount; cluster += 1) {
			for (let slot = 0; slot < (tree.adjacencyCount[cluster] as number); slot += 1) {
				let walk = tree.adjacencyTarget[(tree.adjacencyStart[cluster] as number) + slot] as number;
				expect(walk).not.toBe(cluster);
				for (; walk >= 0; walk = tree.parent[walk] as number) expect(walk).not.toBe(cluster);
			}
		}
	});

	test("keep at most maxNeighbors per cluster", () => {
		const tree = buildClusterTree({
			dimensions: 2,
			edges: randomEdges(2000, 12_000),
			maxNeighbors: 5,
			positions: scatter(2000, 2),
		});
		expect(Math.max(...tree.adjacencyCount)).toBeLessThanOrEqual(5);
	});
});

describe("input", () => {
	test("rejects bad input with an actionable message", () => {
		expect(() => buildClusterTree({ dimensions: 2, positions: new Float32Array([0, 1, 2]) })).toThrow(
			/2 numbers per node/,
		);
		expect(() => buildClusterTree({ dimensions: 2, positions: new Float32Array([0, Number.NaN]) })).toThrow(/finite/);
		expect(() =>
			buildClusterTree({ dimensions: 2, edges: new Uint32Array([0, 5]), positions: new Float32Array([0, 0]) }),
		).toThrow(/does not exist/);
		expect(() => buildClusterTree({ dimensions: 2, leafSize: 0, positions: new Float32Array([0, 0]) })).toThrow(
			/leafSize/,
		);
	});

	test("coincident nodes stay one large leaf", () => {
		const tree = buildClusterTree({ dimensions: 2, positions: new Float32Array(200) });
		expect(tree.clusterCount).toBe(1);
		expect(tree.memberCount[0]).toBe(100);
	});

	test("lists every buffer for a worker transfer", () => {
		const tree = buildClusterTree({ dimensions: 2, edges: randomEdges(100, 200), positions: scatter(100, 2) });
		const buffers = clusterTreeTransferables(tree);
		expect(new Set(buffers).size).toBe(buffers.length);
		expect(buffers.length).toBeGreaterThan(10);
	});
});

describe("startClusterTree", () => {
	const count = 2000;
	const positions = scatter(count, 2);
	const edges = randomEdges(count, 6000);

	test("starts with every node and shape but no edges, and completes to the same tree as buildClusterTree", () => {
		const build = startClusterTree({ dimensions: 2, edges, positions });
		expect(build.tree.clusterCount).toBeGreaterThan(1);
		expect(build.tree.adjacencyTarget.length).toBe(0);
		expect(build.tree.nodeEdgeNeighbor.length).toBe(0);
		expect(build.tree.nodeEdgeStart.length).toBe(count + 1);
		const whole = buildClusterTree({ dimensions: 2, edges, positions });
		Object.assign(build.tree, build.completeEdges());
		for (const [key, value] of Object.entries(whole)) {
			const other = (build.tree as unknown as Record<string, unknown>)[key];
			if (ArrayBuffer.isView(value))
				expect(Array.from(value as unknown as number[]), key).toEqual(Array.from(other as number[]));
			else expect(other, key).toEqual(value);
		}
	});

	test("a cut of the tree without edges draws no edges, and with them draws some", () => {
		const build = startClusterTree({ dimensions: 2, edges, positions });
		const view = { center: { x: 450, y: 450 }, height: 600, mode: "2d", visibleHeight: 1000, width: 800 } as const;
		const cut = createClusterCutter(build.tree)(view, { maxDrawnNodes: 100 });
		expect(cut.clusters.length).toBeGreaterThan(1);
		expect(cut.edgeWeight.length).toBe(0);
		Object.assign(build.tree, build.completeEdges());
		expect(createClusterCutter(build.tree)(view, { maxDrawnNodes: 100 }).edgeWeight.length).toBeGreaterThan(0);
	});

	test("transferables list each buffer once", () => {
		const tree = buildClusterTree({ dimensions: 2, positions });
		const buffers = clusterTreeTransferables({ a: tree.order, b: tree.order, c: tree.centroid });
		expect(buffers).toHaveLength(2);
	});
});
