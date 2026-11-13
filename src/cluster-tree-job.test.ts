import { describe, expect, test } from "vitest";
import { buildClusterTree, type ClusterTreeInput } from "./cluster-tree";
import { startClusterTreeJob } from "./cluster-tree-job";
import { inProcessWorker } from "./test-support/in-process-worker";

function input(count = 2000): ClusterTreeInput {
	const side = Math.ceil(Math.sqrt(count));
	const positions = new Float32Array(count * 2);
	for (let node = 0; node < count; node += 1) {
		positions[node * 2] = (node % side) * 10;
		positions[node * 2 + 1] = Math.floor(node / side) * 10;
	}
	const edges = new Uint32Array(count * 4);
	for (let edge = 0; edge < count * 2; edge += 1) {
		edges[edge * 2] = edge % count;
		edges[edge * 2 + 1] = (edge * 31 + 7) % count;
	}
	return {
		colors: Uint32Array.from({ length: count }, (_, node) => 0x112233 + (node % 3)),
		dimensions: 2,
		edges,
		positions,
	};
}

const sameTree = (left: object, right: object) => {
	for (const [key, value] of Object.entries(left)) {
		const other = (right as Record<string, unknown>)[key];
		if (ArrayBuffer.isView(value))
			expect(Array.from(value as unknown as ArrayLike<number>), key).toEqual(Array.from(other as ArrayLike<number>));
		else expect(value, key).toEqual(other);
	}
};

describe("startClusterTreeJob", () => {
	test("a worker hands over the tree without edges first, then the edges, equal to buildClusterTree", async () => {
		const source = input();
		const expected = buildClusterTree(source);
		const edgeLength = source.edges?.length;
		const log: string[] = [];
		const job = startClusterTreeJob({ ...source }, { createWorker: () => inProcessWorker(log) });
		expect(job.usedWorker).toBe(true);
		const { tree, colors } = await job.coarse;
		expect(tree.adjacencyTarget.length).toBe(0);
		expect(tree.nodeEdgeNeighbor.length).toBe(0);
		expect(colors?.length).toBe(2000);
		const { edgeList, edges } = await job.finished;
		expect(edgeList.length).toBe(edgeLength);
		sameTree(expected, Object.assign(tree, edges));
		expect(log).toContain("terminate");
	});

	test("transfers the arrays to the worker instead of copying them", async () => {
		const source = input();
		const job = startClusterTreeJob({ ...source }, { createWorker: () => inProcessWorker() });
		await job.finished;
		expect(source.positions.byteLength).toBe(0);
		expect(source.edges?.byteLength).toBe(0);
		expect(source.colors?.byteLength).toBe(0);
	});

	test("transfer false keeps the caller's arrays", async () => {
		const source = input();
		await startClusterTreeJob({ ...source }, { createWorker: () => inProcessWorker(), transfer: false }).finished;
		expect(source.positions.byteLength).toBeGreaterThan(0);
		expect(source.edges?.byteLength).toBeGreaterThan(0);
	});

	test("a view onto part of a buffer is copied, so its neighbours are not detached", async () => {
		const backing = new Float32Array(4000 + 8);
		const positions = backing.subarray(8);
		positions.set(input().positions);
		await startClusterTreeJob({ ...input(), positions }, { createWorker: () => inProcessWorker() }).finished;
		expect(backing.byteLength).toBeGreaterThan(0);
	});

	test("builds on this thread when workers are off, with the first step before the second", async () => {
		const source = input();
		const expected = buildClusterTree(source);
		const job = startClusterTreeJob(source, { worker: false });
		expect(job.usedWorker).toBe(false);
		const { tree } = await job.coarse;
		expect(tree.adjacencyTarget.length).toBe(0);
		sameTree(expected, Object.assign(tree, (await job.finished).edges));
		expect(source.positions.byteLength).toBeGreaterThan(0);
	});

	test("falls back to this thread when the worker cannot be created", async () => {
		const job = startClusterTreeJob(input(), {
			createWorker: () => {
				throw new Error("no workers here");
			},
		});
		expect(job.usedWorker).toBe(false);
		expect((await job.finished).edges.adjacencyTarget.length).toBeGreaterThan(0);
	});

	test("without transfer, a worker that fails to start falls back to this thread", async () => {
		const failing = {
			onerror: null as ((event: { message: string }) => void) | null,
			postMessage() {},
			terminate() {},
		};
		const job = startClusterTreeJob(input(), { createWorker: () => failing as unknown as Worker, transfer: false });
		failing.onerror?.({ message: "404" });
		expect((await job.finished).edges.adjacencyTarget.length).toBeGreaterThan(0);
	});

	test("with transfer, a worker that fails to start rejects with a clear error", async () => {
		const failing = {
			onerror: null as ((event: { message: string }) => void) | null,
			postMessage() {},
			terminate() {},
		};
		const job = startClusterTreeJob(input(), { createWorker: () => failing as unknown as Worker });
		failing.onerror?.({ message: "404" });
		await expect(job.coarse).rejects.toThrow("Cluster tree build failed: 404");
	});

	test("reports invalid input from the worker and from this thread", async () => {
		const bad = () => ({ dimensions: 2 as const, positions: new Float32Array([0, 1, 2, Number.NaN]) });
		await expect(startClusterTreeJob(bad(), { createWorker: () => inProcessWorker() }).coarse).rejects.toThrow(
			"finite",
		);
		await expect(startClusterTreeJob(bad(), { worker: false }).coarse).rejects.toThrow("finite");
	});

	test("terminate stops the job and rejects what is pending", async () => {
		const log: string[] = [];
		const job = startClusterTreeJob(input(), { createWorker: () => inProcessWorker(log) });
		job.terminate();
		await expect(job.coarse).rejects.toThrow("stopped");
		await expect(job.finished).rejects.toThrow("stopped");
		const local = startClusterTreeJob(input(), { worker: false });
		local.terminate();
		await expect(local.finished).rejects.toThrow("stopped");
	});
});
