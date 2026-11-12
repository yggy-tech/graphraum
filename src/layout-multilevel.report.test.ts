/**
 * Measure-first report for the multilevel layout: time and quality of the plain force layout against
 * the multilevel one on sparse random graphs. Writes a Markdown table to a file because the test config
 * swallows console output:
 * `MULTILEVEL_REPORT=1 MULTILEVEL_OUT=/tmp/multilevel.md bunx vitest run src/layout-multilevel.report.test.ts`.
 */
import { expect, test } from "vitest";

import { computeForcePositions, DEFAULT_FORCE_SETTINGS, type ForceLayoutStyle } from "./force-layout";
import { computeMultilevelForcePositions } from "./layout-multilevel";
import { sampledLayoutQuality, sparseRandomGraph } from "./test-support/layout-quality";

const environment = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const REPORT = environment?.MULTILEVEL_REPORT === "1";
const STYLES: ForceLayoutStyle[] = ["classic", "edge-t"];
const SIZES = [1_000, 10_000, 100_000];

function median(values: number[]) {
	return values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;
}

function timed<T>(run: () => T, repeats = 3): { milliseconds: number; result: T } {
	let result = run();
	const times: number[] = [];
	for (let repeat = 0; repeat < repeats; repeat += 1) {
		const startedAt = performance.now();
		result = run();
		times.push(performance.now() - startedAt);
	}
	return { milliseconds: median(times), result };
}

test.runIf(REPORT)(
	"reports time and quality of the multilevel layout",
	async () => {
		const rows = [
			"| Nodes | Style | Dim | Algorithm | ms | Stress | Edge CV | kNN overlap |",
			"| --- | --- | --- | --- | --- | --- | --- | --- |",
		];
		for (const nodeCount of SIZES) {
			const graph = sparseRandomGraph(nodeCount, 7, 6);
			for (const layoutStyle of STYLES) {
				for (const dimensions of [2, 3] as const) {
					const request = {
						dimensions,
						edges: graph.edges,
						nodeCount,
						settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle },
					};
					const plain = timed(() => computeForcePositions(request));
					const multilevel = timed(() => computeMultilevelForcePositions(request));
					for (const [name, run] of [
						["plain", plain],
						["multilevel", multilevel],
					] as const) {
						const quality = sampledLayoutQuality(graph, run.result, 16);
						rows.push(
							`| ${nodeCount} | ${layoutStyle} | ${dimensions}D | ${name} | ${run.milliseconds.toFixed(0)} | ${quality.stress.toFixed(3)} | ${quality.edgeLengthCv.toFixed(3)} | ${quality.neighborhoodPreservation.toFixed(3)} |`,
						);
					}
				}
			}
		}
		const out = environment?.MULTILEVEL_OUT;
		expect(out).toBeTruthy();
		const fileSystem = "node:fs";
		(await import(fileSystem)).writeFileSync(out as string, `${rows.join("\n")}\n`);
	},
	900_000,
);
