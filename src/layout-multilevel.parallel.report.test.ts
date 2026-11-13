/**
 * Opt-in quality report: the parallel multilevel layout against the single-thread one in the edge-t style.
 * Workers run in this thread (same math as real ones), so only quality is reported, not speed:
 * `MULTILEVEL_REPORT=1 MULTILEVEL_OUT=/tmp/parallel.md bunx vitest run src/layout-multilevel.parallel.report.test.ts`.
 */
import { expect, test } from "vitest";

import { DEFAULT_FORCE_SETTINGS } from "./force-layout";
import { computeMultilevelForcePositions, computeMultilevelForcePositionsAsync } from "./layout-multilevel";
import {
	denseCommunities,
	type QualityGraph,
	sampledLayoutQuality,
	sparseRandomGraph,
} from "./test-support/layout-quality";
import { inProcessRegionWorker } from "./test-support/region-worker";

const environment = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const REPORT = environment?.MULTILEVEL_REPORT === "1";

test.runIf(REPORT)(
	"reports the quality of the parallel multilevel layout",
	async () => {
		const graphs: QualityGraph[] = [
			sparseRandomGraph(10_000, 7, 6),
			sparseRandomGraph(100_000, 7, 6),
			denseCommunities(
				11,
				Array.from({ length: 10 }, () => 1_000),
				20,
			),
			denseCommunities(
				11,
				Array.from({ length: 40 }, () => 2_500),
				20,
			),
		];
		const rows = [
			"| Graph | Nodes | Layout | Stress | Edge CV | kNN overlap |",
			"| --- | --- | --- | --- | --- | --- |",
		];
		for (const graph of graphs) {
			const request = {
				dimensions: 3 as const,
				edges: graph.edges,
				nodeCount: graph.nodeCount,
				settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle: "edge-t" as const },
			};
			const single = computeMultilevelForcePositions(request);
			const parallel = await computeMultilevelForcePositionsAsync(request, {
				createWorker: () => inProcessRegionWorker(),
				workers: 8,
			});
			for (const [name, positions] of [
				["single thread", single],
				["8 workers", parallel],
			] as const) {
				const q = sampledLayoutQuality(graph, positions, 16);
				rows.push(
					`| ${graph.name} | ${graph.nodeCount} | ${name} | ${q.stress.toFixed(4)} | ${q.edgeLengthCv.toFixed(4)} | ${q.neighborhoodPreservation.toFixed(4)} |`,
				);
			}
		}
		const out = environment?.MULTILEVEL_OUT;
		expect(out).toBeTruthy();
		const fileSystem = "node:fs";
		(await import(fileSystem)).writeFileSync(out as string, `${rows.join("\n")}\n`);
	},
	1_800_000,
);
