import { expect, test } from "vitest";

import { DEFAULT_FORCE_SETTINGS } from "./force-layout";
import { computeMultilevelForcePositions, computeMultilevelForcePositionsAsync } from "./layout-multilevel";
import { sampledLayoutQuality, sparseRandomGraph } from "./test-support/layout-quality";

const graph = sparseRandomGraph(40_000, 3, 6);
const request = {
	dimensions: 3 as const,
	edges: graph.edges,
	nodeCount: graph.nodeCount,
	settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle: "edge-t" as const },
};
const createWorker = () => new Worker(new URL("./layout-multilevel-worker.ts", import.meta.url), { type: "module" });

test("refines large levels in real workers and stays close to the single-thread layout", async () => {
	const parallel = await computeMultilevelForcePositionsAsync(request, { createWorker, workers: 4 });
	const again = await computeMultilevelForcePositionsAsync(request, { createWorker, workers: 4 });
	expect([...again]).toEqual([...parallel]);
	const single = sampledLayoutQuality(graph, computeMultilevelForcePositions(request), 8);
	const quality = sampledLayoutQuality(graph, parallel, 8);
	expect(quality.stress).toBeLessThan(single.stress * 1.05);
	expect(quality.stress).toBeGreaterThan(single.stress * 0.95);
}, 120_000);

test("falls back to one thread when the worker script cannot load", async () => {
	const broken = () => new Worker(new URL("./does-not-exist.js", import.meta.url), { type: "module" });
	const result = await computeMultilevelForcePositionsAsync(request, { createWorker: broken, workers: 3 });
	expect([...result]).toEqual([...computeMultilevelForcePositions(request)]);
}, 120_000);
