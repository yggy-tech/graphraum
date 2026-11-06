/**
 * Measure-first report for the pivot MDS start (#193). Writes a Markdown table to a file because the test
 * config swallows console output:
 * `PIVOT_REPORT=1 PIVOT_OUT=/tmp/pivot.md bunx vitest run src/layout-start.report.test.ts`.
 */
import { expect, test } from "vitest";

import { createForceSimulation, DEFAULT_FORCE_SETTINGS, type ForceLayoutStyle } from "./force-layout";
import { pivotMdsPositions } from "./layout-start";
import {
	foldCount,
	gridStrip,
	normalizedStress,
	pathWithBranches,
	type QualityGraph,
	rolledStrip,
	seededRandom,
	sparseRandomGraph,
} from "./test-support/layout-quality";

const environment = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const REPORT = environment?.PIVOT_REPORT === "1";
const STYLES: ForceLayoutStyle[] = ["classic", "edge-t"];
const SEEDS = [1, 2, 3];

interface Start {
	name: string;
	pivots?: number;
}
const STARTS: Start[] = [
	{ name: "random" },
	{ name: "pm20", pivots: 20 },
	{ name: "pm50", pivots: 50 },
	{ name: "pm100", pivots: 100 },
];

/** Relabel nodes with a seeded permutation: the random start and the sampling depend on node ids. */
function relabel(graph: QualityGraph, seed: number) {
	const random = seededRandom(seed);
	const permutation = Uint32Array.from({ length: graph.nodeCount }, (_, index) => index);
	for (let index = permutation.length - 1; index > 0; index -= 1) {
		const other = Math.floor(random() * (index + 1));
		[permutation[index], permutation[other]] = [permutation[other] ?? 0, permutation[index] ?? 0];
	}
	return { edges: Uint32Array.from(graph.edges, (node) => permutation[node] ?? 0), permutation };
}

function run(graph: QualityGraph, start: Start, style: ForceLayoutStyle, seed: number) {
	const { edges, permutation } = relabel(graph, seed);
	const settings = { ...DEFAULT_FORCE_SETTINGS, layoutStyle: style };
	const begun = performance.now();
	const request = { dimensions: 2 as const, edges, nodeCount: graph.nodeCount, settings };
	let startMs = 0;
	let startFolds: number | null = null;
	let initialPositions: Float32Array | undefined;
	const unpermute = (positions: Float32Array) => {
		const out = new Float32Array(positions.length);
		for (let node = 0; node < graph.nodeCount; node += 1) {
			const source = (permutation[node] ?? 0) * 3;
			out.set(positions.subarray(source, source + 3), node * 3);
		}
		return out;
	};
	if (start.pivots) {
		const mark = performance.now();
		initialPositions = pivotMdsPositions({ ...request, linkDistance: settings.linkDistance }, { pivots: start.pivots });
		startMs = performance.now() - mark;
	}
	const simulation = createForceSimulation({ ...request, initialPositions });
	if (initialPositions && graph.strip) startFolds = foldCount(graph.strip, unpermute(simulation.positions));
	const total =
		Math.max(8, Math.min(32, Math.ceil(240 / Math.log2(graph.nodeCount + 2)))) * (style === "edge-t" ? 8 : 1);
	for (let iteration = 0; iteration < total; iteration += 1) simulation.step(1 - iteration / total);
	const totalMs = performance.now() - begun;
	const final = unpermute(simulation.positions);
	return {
		folds: graph.strip ? foldCount(graph.strip, final) : 0,
		startFolds,
		startMs,
		stress: graph.nodeCount <= 2000 ? normalizedStress(graph, final) : Number.NaN,
		totalMs,
	};
}

async function writeReport(rows: string[]) {
	const fileSystem = "node:fs";
	(await import(fileSystem)).writeFileSync(environment?.PIVOT_OUT ?? "pivot-report.md", rows.join("\n"));
}

test.runIf(REPORT)(
	"reports the pivot MDS start comparison",
	async () => {
		const fixtures = [
			gridStrip(20, 40),
			gridStrip(9, 90),
			gridStrip(4, 200),
			gridStrip(2, 400),
			rolledStrip(),
			pathWithBranches(),
		];
		const rows = [
			"| Fixture | Start | Style | Stress | Folds (3 seeds) | Start folds | Start ms | Total ms |",
			"| --- | --- | --- | --- | --- | --- | --- | --- |",
		];
		for (const graph of fixtures) {
			for (const start of STARTS) {
				for (const style of STYLES) {
					const runs = SEEDS.map((seed) => run(graph, start, style, seed));
					const mean = (pick: (r: (typeof runs)[number]) => number) =>
						runs.reduce((sum, r) => sum + pick(r), 0) / runs.length;
					rows.push(
						`| ${graph.name} (${graph.nodeCount}) | ${start.name} | ${style} | ${mean((r) => r.stress).toFixed(3)} | ${runs.map((r) => r.folds).join("/")} | ${runs[0]?.startFolds ?? "-"} | ${mean((r) => r.startMs).toFixed(1)} | ${mean((r) => r.totalMs).toFixed(0)} |`,
					);
				}
			}
		}
		await writeReport(rows);
		expect(rows.length).toBeGreaterThan(2);
	},
	900_000,
);

test.runIf(REPORT)(
	"reports the pivot MDS start timing at 10k nodes",
	async () => {
		const rows = [
			"| Graph | Start | Style | Start ms | Layout ms (incl. start) | Start folds | Folds |",
			"| --- | --- | --- | --- | --- | --- | --- |",
		];
		for (const graph of [gridStrip(10, 1000), sparseRandomGraph(10_000)]) {
			for (const start of STARTS.filter((entry) => entry.pivots !== 50)) {
				for (const style of STYLES) {
					const result = run(graph, start, style, 1);
					rows.push(
						`| ${graph.name} | ${start.name} | ${style} | ${result.startMs.toFixed(0)} | ${result.totalMs.toFixed(0)} | ${result.startFolds ?? "-"} | ${graph.strip ? result.folds : "-"} |`,
					);
				}
			}
		}
		await writeReport(rows.map((row) => row));
		expect(rows.length).toBeGreaterThan(2);
	},
	900_000,
);
