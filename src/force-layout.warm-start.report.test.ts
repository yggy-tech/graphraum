/**
 * Opt-in measurement for reusing positions at 100k nodes and 300k edges (#147). Writes a Markdown table to
 * a file because the test config swallows console output:
 * `WARM_REPORT=1 WARM_OUT=/tmp/warm.md bunx vitest run src/force-layout.warm-start.report.test.ts`.
 */
import { expect, test } from "vitest";

import { computeForcePositions, DEFAULT_FORCE_SETTINGS, type ForceLayoutStyle } from "./force-layout";
import { placeNewNodes } from "./layout-start";
import { seededRandom } from "./test-support/layout-quality";

const environment = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const REPORT = environment?.WARM_REPORT === "1";
const NODES = 100_000;
const EDGES = 300_000;
const STYLES: ForceLayoutStyle[] = ["classic", "edge-t"];

function median(values: Float64Array) {
	return values.toSorted()[Math.floor(values.length / 2)] ?? 0;
}

test.skipIf(!REPORT)("warm start at 100k nodes and 300k edges", { timeout: 3_600_000 }, async () => {
	const random = seededRandom(3);
	const rows: string[] = [
		"| style | cold ms | warm ms (+5% nodes) | median move, warm (link distances) |",
		"| --- | --- | --- | --- |",
	];
	for (const style of STYLES) {
		const settings = { ...DEFAULT_FORCE_SETTINGS, layoutStyle: style };
		const pairs = new Uint32Array(EDGES * 2);
		for (let edge = 0; edge < EDGES; edge += 1) {
			const source = edge % NODES;
			pairs[edge * 2] = source;
			pairs[edge * 2 + 1] = (source + 1 + Math.floor(random() * 50)) % NODES;
		}
		const coldStartedAt = performance.now();
		const settled = computeForcePositions({ dimensions: 3, edges: pairs, nodeCount: NODES, settings });
		const cold = performance.now() - coldStartedAt;
		const added = NODES / 20;
		const nodeCount = NODES + added;
		const extra = new Uint32Array(added * 6);
		for (let node = 0; node < added; node += 1) {
			for (let link = 0; link < 3; link += 1) {
				extra[(node * 3 + link) * 2] = NODES + node;
				extra[(node * 3 + link) * 2 + 1] = Math.floor(random() * NODES);
			}
		}
		const edges = new Uint32Array(pairs.length + extra.length);
		edges.set(pairs);
		edges.set(extra, pairs.length);
		const initialPositions = new Float32Array(nodeCount * 3).fill(Number.NaN);
		initialPositions.set(settled);
		const warmStartedAt = performance.now();
		const warm = computeForcePositions({
			dimensions: 3,
			edges,
			initialPositions: placeNewNodes({ dimensions: 3, edges, nodeCount }, initialPositions),
			nodeCount,
			settings,
			warmStart: true,
		});
		const warmMilliseconds = performance.now() - warmStartedAt;
		const moved = new Float64Array(NODES);
		for (let node = 0; node < NODES; node += 1) {
			moved[node] = Math.hypot(
				(warm[node * 3] ?? 0) - (settled[node * 3] ?? 0),
				(warm[node * 3 + 1] ?? 0) - (settled[node * 3 + 1] ?? 0),
				(warm[node * 3 + 2] ?? 0) - (settled[node * 3 + 2] ?? 0),
			);
		}
		rows.push(
			`| ${style} | ${cold.toFixed(0)} | ${warmMilliseconds.toFixed(0)} | ${(median(moved) / settings.linkDistance).toFixed(2)} |`,
		);
	}
	const fileSystem = "node:fs";
	(await import(fileSystem)).writeFileSync(environment?.WARM_OUT ?? "warm-start-report.md", `${rows.join("\n")}\n`);
	expect(rows.length).toBe(STYLES.length + 2);
});
