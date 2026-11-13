import { describe, expect, test } from "vitest";

import { DEFAULT_FORCE_SETTINGS, type ForceLayoutRequest } from "./force-layout";
import { computeMultilevelForcePositions, computeMultilevelForcePositionsAsync } from "./layout-multilevel";
import { sampledLayoutQuality, sparseRandomGraph } from "./test-support/layout-quality";
import { inProcessRegionWorker } from "./test-support/region-worker";

const graph = sparseRandomGraph(30_000, 5, 6);
const edgeT = { ...DEFAULT_FORCE_SETTINGS, layoutStyle: "edge-t" as const };

function request(patch: Partial<ForceLayoutRequest> = {}): ForceLayoutRequest {
	return { dimensions: 3, edges: graph.edges, nodeCount: graph.nodeCount, settings: edgeT, ...patch };
}

/** Counts the workers started and terminated, so a test can see that none are left running. */
function countedWorkers(failOn?: Parameters<typeof inProcessRegionWorker>[0]) {
	const counts = { started: 0, terminated: 0 };
	return {
		counts,
		createWorker: () => {
			counts.started += 1;
			const worker = inProcessRegionWorker(failOn);
			const terminate = worker.terminate.bind(worker);
			worker.terminate = () => {
				counts.terminated += 1;
				terminate();
			};
			return worker;
		},
	};
}

describe("computeMultilevelForcePositionsAsync", () => {
	test("is deterministic for a seed and a worker count", async () => {
		const run = (workers: number, seed: number) =>
			computeMultilevelForcePositionsAsync(request(), {
				createWorker: () => inProcessRegionWorker(),
				seed,
				workers,
			});
		const first = await run(3, 2);
		expect([...(await run(3, 2))]).toEqual([...first]);
		expect([...(await run(3, 3))]).not.toEqual([...first]);
	});

	test("shared memory and posted positions agree", async () => {
		const run = (sharedMemory: boolean) =>
			computeMultilevelForcePositionsAsync(request(), {
				createWorker: () => inProcessRegionWorker(),
				sharedMemory,
				workers: 3,
			});
		expect([...(await run(true))]).toEqual([...(await run(false))]);
	});

	test("keeps the stress and edge length spread of the single-thread layout", async () => {
		const single = sampledLayoutQuality(graph, computeMultilevelForcePositions(request()), 8);
		const parallel = sampledLayoutQuality(
			graph,
			await computeMultilevelForcePositionsAsync(request(), {
				createWorker: () => inProcessRegionWorker(),
				workers: 4,
			}),
			8,
		);
		expect(parallel.stress).toBeLessThan(single.stress * 1.05);
		expect(parallel.stress).toBeGreaterThan(single.stress * 0.95);
		expect(Math.abs(parallel.edgeLengthCv - single.edgeLengthCv)).toBeLessThan(0.05 * single.edgeLengthCv);
	});

	test("starts workers for the large levels and terminates them all", async () => {
		const { counts, createWorker } = countedWorkers();
		await computeMultilevelForcePositionsAsync(request(), { createWorker, workers: 3 });
		expect(counts.started).toBe(3);
		expect(counts.terminated).toBe(3);
	});

	test.each([
		["workers set to 1", { workers: 1 }, request()],
		["workers set to 0", { workers: 0 }, request()],
		["the classic style", { workers: 4 }, request({ settings: DEFAULT_FORCE_SETTINGS })],
		["a graph too small to split", { workers: 4 }, request({ edges: new Uint32Array(), nodeCount: 8_000 })],
	])("runs on one thread for %s", async (_name, options, input) => {
		const { counts, createWorker } = countedWorkers();
		const result = await computeMultilevelForcePositionsAsync(input, { ...options, createWorker });
		expect(counts.started).toBe(0);
		expect([...result]).toEqual([...computeMultilevelForcePositions(input)]);
	});

	test("runs on one thread where there are no workers", async () => {
		const result = await computeMultilevelForcePositionsAsync(request());
		expect([...result]).toEqual([...computeMultilevelForcePositions(request())]);
	});

	test("falls back to one thread when a worker cannot be started", async () => {
		const result = await computeMultilevelForcePositionsAsync(request(), {
			createWorker: () => {
				throw new Error("no workers here");
			},
			workers: 4,
		});
		expect([...result]).toEqual([...computeMultilevelForcePositions(request())]);
	});

	test.each(["init", "round"] as const)("falls back to one thread when a worker fails on %s", async (failOn) => {
		const { counts, createWorker } = countedWorkers(failOn);
		const result = await computeMultilevelForcePositionsAsync(request(), { createWorker, workers: 3 });
		expect([...result]).toEqual([...computeMultilevelForcePositions(request())]);
		expect(counts.terminated).toBe(counts.started);
	});

	test("reports the phases like the single-thread layout and previews once", async () => {
		const phases: string[] = [];
		let previews = 0;
		await computeMultilevelForcePositionsAsync(request(), {
			createWorker: () => inProcessRegionWorker(),
			onPreview: () => {
				previews += 1;
			},
			onProgress: ({ phase }) => phases.push(phase),
			workers: 3,
		});
		expect(previews).toBe(1);
		expect(phases[0]).toBe("coarsen");
		expect(phases[1]).toBe("coarsest");
		expect(phases.slice(2).every((phase) => phase === "refine")).toBe(true);
	});

	test.each([-1, 33, 1.5])("rejects workers %s", async (workers) => {
		await expect(computeMultilevelForcePositionsAsync(request(), { workers })).rejects.toThrow(/workers/);
	});

	test("does not change its input", async () => {
		const edges = graph.edges.slice();
		await computeMultilevelForcePositionsAsync(request(), { createWorker: () => inProcessRegionWorker(), workers: 3 });
		expect([...graph.edges]).toEqual([...edges]);
	});
});
