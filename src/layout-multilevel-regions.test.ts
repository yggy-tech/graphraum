import { describe, expect, test } from "vitest";

import { createForceSimulation, DEFAULT_FORCE_SETTINGS } from "./force-layout";
import {
	MIN_REGION_NODES,
	partitionRegions,
	type RegionJob,
	RegionPool,
	refineInRegions,
	regionCountFor,
	shareOutRegions,
} from "./layout-multilevel-regions";
import { sparseRandomGraph } from "./test-support/layout-quality";
import { inProcessRegionWorker } from "./test-support/region-worker";

function randomPositions(nodeCount: number) {
	const positions = new Float32Array(nodeCount * 3);
	for (let index = 0; index < positions.length; index += 1) positions[index] = Math.sin(index * 12.9898) * 300;
	return positions;
}

function jobFor(nodeCount: number, steps = 4): RegionJob {
	const graph = sparseRandomGraph(nodeCount, 3, 6);
	return {
		alphas: Array.from({ length: steps }, (_, step) => 0.4 * (1 - step / steps)),
		nodeWeights: new Float32Array(nodeCount).fill(5),
		request: {
			dimensions: 2,
			edges: graph.edges,
			initialPositions: randomPositions(nodeCount),
			nodeCount,
			settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle: "edge-t" },
			warmStart: true,
		},
	};
}

describe("regionCountFor", () => {
	test("gives every region at least MIN_REGION_NODES and never more than the workers", () => {
		expect(regionCountFor(MIN_REGION_NODES - 1, 8)).toBe(1);
		expect(regionCountFor(MIN_REGION_NODES * 3, 8)).toBe(3);
		expect(regionCountFor(MIN_REGION_NODES * 100, 8)).toBe(8);
		expect(regionCountFor(MIN_REGION_NODES * 100, 0)).toBe(1);
	});
});

describe("partitionRegions", () => {
	test("splits into balanced regions and is deterministic", () => {
		const positions = randomPositions(9_000);
		const weights = new Float32Array(9_000).fill(1);
		for (const regions of [2, 3, 5, 8]) {
			const owner = partitionRegions(positions, weights, 3, regions);
			const sizes = new Array<number>(regions).fill(0);
			for (const region of owner) sizes[region] += 1;
			for (const size of sizes) expect(Math.abs(size - 9_000 / regions)).toBeLessThan(9_000 * 0.03);
			expect([...partitionRegions(positions, weights, 3, regions)]).toEqual([...owner]);
		}
	});

	test("balances the weight, not the count", () => {
		const positions = randomPositions(6_000);
		const weights = Float32Array.from({ length: 6_000 }, (_, node) => (node % 10 === 0 ? 20 : 1));
		const owner = partitionRegions(positions, weights, 2, 2);
		const load = [0, 0];
		for (const [node, region] of owner.entries()) load[region] += weights[node] ?? 0;
		expect(Math.abs((load[0] ?? 0) - (load[1] ?? 0))).toBeLessThan(0.05 * ((load[0] ?? 0) + (load[1] ?? 0)));
	});

	test("cuts along space: regions of a line of nodes are intervals", () => {
		const positions = new Float32Array(6_000 * 3);
		for (let node = 0; node < 6_000; node += 1) positions[node * 3] = node;
		const owner = partitionRegions(positions, new Float32Array(6_000).fill(1), 2, 4);
		const ranges = [0, 1, 2, 3].map((region) => {
			const xs = [...owner.keys()].filter((node) => owner[node] === region);
			return [Math.min(...xs), Math.max(...xs)] as const;
		});
		for (const [region, [low, high]] of ranges.entries()) {
			const members = [...owner].filter((candidate) => candidate === region).length;
			expect(high - low + 1).toBe(members);
		}
	});
});

describe("shareOutRegions", () => {
	test("lists every node once and every edge with both of its regions", () => {
		const job = jobFor(6_000);
		const owner = partitionRegions(job.request.initialPositions, job.nodeWeights, 2, 3);
		const shares = shareOutRegions(job, owner, 3);
		expect(shares.reduce((sum, share) => sum + share.owned.length, 0)).toBe(6_000);
		const seen = new Set<number>();
		for (const [region, share] of shares.entries()) {
			for (const node of share.owned) {
				expect(owner[node]).toBe(region);
				seen.add(node);
			}
		}
		expect(seen.size).toBe(6_000);
		let crossing = 0;
		for (let index = 0; index < job.request.edges.length; index += 2) {
			if (owner[job.request.edges[index] ?? 0] !== owner[job.request.edges[index + 1] ?? 0]) crossing += 1;
		}
		const shared = shares.reduce((sum, share) => sum + share.edges.length / 2, 0);
		expect(shared).toBe(job.request.edges.length / 2 + crossing);
	});

	test("carries the per-edge arrays with their edges", () => {
		const job = jobFor(6_000);
		const edgeCount = job.request.edges.length / 2;
		job.request.springStrengths = Float32Array.from({ length: edgeCount }, (_, edge) => 0.001 + edge * 1e-9);
		const owner = partitionRegions(job.request.initialPositions, job.nodeWeights, 2, 2);
		for (const share of shareOutRegions(job, owner, 2)) {
			for (let slot = 0; slot < share.edges.length / 2; slot += 1) {
				const source = share.edges[slot * 2] ?? 0;
				const target = share.edges[slot * 2 + 1] ?? 0;
				const strength = share.springStrengths?.[slot] ?? 0;
				// The strength encodes the edge index, so the edge it belongs to must have these ends.
				const edge = Math.round((strength - 0.001) / 1e-9);
				expect(job.request.edges[edge * 2]).toBe(source);
				expect(job.request.edges[edge * 2 + 1]).toBe(target);
			}
		}
	});
});

describe("refineInRegions", () => {
	function maxDifference(left: Float32Array, right: Float32Array) {
		let largest = 0;
		for (let index = 0; index < left.length; index += 1) {
			largest = Math.max(largest, Math.abs((left[index] ?? 0) - (right[index] ?? 0)));
		}
		return largest;
	}

	function singleThread(job: RegionJob) {
		const simulation = createForceSimulation(job.request);
		for (const alpha of job.alphas) simulation.step(alpha);
		return simulation.positions;
	}

	test("with an exchange after every step it stays close to one thread", async () => {
		const job = jobFor(10_000);
		const pool = new RegionPool(() => inProcessRegionWorker(), 4);
		try {
			const regions = await refineInRegions(job, pool, 4, { shared: false, syncSteps: 1 });
			const single = singleThread(job);
			// Same samples, same math; only the per-step re-centring differs, so no node is far from its twin.
			expect(maxDifference(regions, single)).toBeLessThan(2);
		} finally {
			pool.dispose();
		}
	});

	test("shared memory and posted positions give the same result", async () => {
		const job = jobFor(10_000);
		const pool = new RegionPool(() => inProcessRegionWorker(), 3);
		try {
			const posted = await refineInRegions(job, pool, 3, { shared: false });
			const shared = await refineInRegions(job, pool, 3, { shared: true });
			expect([...shared]).toEqual([...posted]);
		} finally {
			pool.dispose();
		}
	});

	test("is deterministic for a worker count and does not change its input", async () => {
		const job = jobFor(10_000);
		const start = job.request.initialPositions.slice();
		const edges = job.request.edges.slice();
		const run = async () => {
			const pool = new RegionPool(() => inProcessRegionWorker(), 4);
			try {
				return await refineInRegions(job, pool, 4, { shared: false });
			} finally {
				pool.dispose();
			}
		};
		const first = await run();
		expect([...(await run())]).toEqual([...first]);
		expect([...job.request.initialPositions]).toEqual([...start]);
		expect([...job.request.edges]).toEqual([...edges]);
	});

	test("rejects when a worker fails", async () => {
		const pool = new RegionPool(() => inProcessRegionWorker("round"), 2);
		try {
			await expect(refineInRegions(jobFor(10_000), pool, 2, { shared: false })).rejects.toThrow(/forced round failure/);
		} finally {
			pool.dispose();
		}
	});
});
