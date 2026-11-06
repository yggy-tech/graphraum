/**
 * Does the force layout exaggerate how isolated a small cluster looks (#192, step 1: measure)?
 * Every cluster of the size-sweep block model has the same graph separation G_g; the layout is
 * unbiased when the visual separation V_g does not depend on cluster size.
 * `CLUSTER_SEPARATION_REPORT=1 bun run test src/force-layout.cluster-separation.test.ts` prints the
 * tables; the default run only checks the fixture and the metric.
 */
import { describe, expect, test } from "vitest";

import { computeForcePositions, DEFAULT_FORCE_SETTINGS, type ForceLayoutStyle } from "./force-layout";
import {
	type ClusterSeparation,
	clusterSeparations,
	discReference,
	sizeSweepBlockModel,
} from "./test-support/layout-quality";

const environment = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const REPORT = environment?.CLUSTER_SEPARATION_REPORT === "1";
const SHARES = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5];
const SEEDS = [1, 2, 3, 4, 5, 6];

describe("size sweep block model", () => {
	test("gives every cluster the same graph separation at any minority share", () => {
		for (const share of SHARES) {
			const graph = sizeSweepBlockModel(share, 3);
			const positions = new Float32Array(graph.nodeCount * 3);
			for (const [group, separation] of clusterSeparations(graph, positions).entries()) {
				expect(Math.abs(separation.graphSeparation - 0.9), `share ${share}, cluster ${group}`).toBeLessThan(0.03);
			}
		}
	});

	test("is deterministic and sizes the minority as asked", () => {
		const a = sizeSweepBlockModel(0.05, 9);
		const b = sizeSweepBlockModel(0.05, 9);
		expect(a.edges).toEqual(b.edges);
		expect(a.groups.filter((group) => group === 0).length).toBe(40);
	});

	test("measures V_g as outside over inside distance", () => {
		const graph = { edges: new Uint32Array(), groups: Uint32Array.of(0, 0, 1, 1), name: "pairs", nodeCount: 4 };
		const positions = Float32Array.of(0, 0, 0, 1, 0, 0, 10, 0, 0, 11, 0, 0);
		const [first] = clusterSeparations(graph, positions);
		expect(first?.visualSeparation).toBeCloseTo(10, 5);
	});
});

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sd = (values: number[]) => Math.sqrt(mean(values.map((value) => (value - mean(values)) ** 2)));

function slope(xs: number[], ys: number[]) {
	const mx = mean(xs);
	const my = mean(ys);
	return (
		xs.reduce((sum, x, i) => sum + (x - mx) * ((ys[i] ?? 0) - my), 0) / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0)
	);
}

type Layout = "classic off" | "classic on" | "edge-t off" | "edge-t on" | "disc reference" | "disc reference, wide gap";
const LAYOUTS: Layout[] = [
	"disc reference",
	"disc reference, wide gap",
	"classic off",
	"classic on",
	"edge-t off",
	"edge-t on",
];

function separationsOf(share: number, seed: number, layout: Layout) {
	const graph = sizeSweepBlockModel(share, seed);
	let positions: Float32Array;
	if (layout.startsWith("disc")) positions = discReference(graph, seed, layout.endsWith("wide gap") ? 1 : 0.2);
	else {
		positions = computeForcePositions({
			clusters: layout.endsWith("on") ? graph.groups : undefined,
			dimensions: 2,
			edges: graph.edges,
			nodeCount: graph.nodeCount,
			settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle: layout.split(" ")[0] as ForceLayoutStyle },
		});
	}
	return { graph, separations: clusterSeparations(graph, positions) };
}

type Metric = "gap" | "purity" | "visualSeparation";
const pick = (rows: ClusterSeparation[], metric: Metric) => rows.map((row) => row[metric]);

test.runIf(REPORT)(
	"reports the size coefficient of V_g, purity and gap at fixed G_g",
	() => {
		const started = performance.now();
		const lines: string[] = [];
		const coefficients: string[] = [];
		const tables: Record<Metric, string[]> = {
			gap: ["| Layout | share | gap min | gap rest | ratio |", "| --- | --- | --- | --- | --- |"],
			purity: ["| Layout | share | P_min | P_rest | ratio |", "| --- | --- | --- | --- | --- |"],
			visualSeparation: [
				"| Layout | share | V_min | V_rest | ratio mean | ratio sd | ratio min..max |",
				"| --- | --- | --- | --- | --- | --- | --- |",
			],
		};
		const v = (values: number[]) => `${mean(values).toFixed(2)} ±${sd(values).toFixed(2)}`;
		for (const layout of LAYOUTS) {
			const logSize: number[] = [];
			const logRatio: Record<Metric, number[]> = { gap: [], purity: [], visualSeparation: [] };
			for (const share of SHARES) {
				const runs = SEEDS.map((seed) => separationsOf(share, seed, layout).separations);
				for (const metric of ["visualSeparation", "purity", "gap"] as const) {
					const minority = runs.map((rows) => pick(rows, metric)[0] ?? 0);
					const rest = runs.map((rows) => mean(pick(rows, metric).slice(1)));
					const ratios = minority.map((value, index) => value / (rest[index] ?? 1));
					const restShares = runs.map(
						(rows) =>
							mean(rows.slice(1).map((row) => row.nodeCount)) / rows.reduce((sum, row) => sum + row.nodeCount, 0),
					);
					if (metric === "visualSeparation")
						for (const restShare of restShares) logSize.push(Math.log(share / restShare));
					for (const ratio of ratios) logRatio[metric].push(Math.log(Math.max(ratio, 1e-3)));
					const label = `${layout} | ${share * 100}%`;
					if (metric === "visualSeparation") {
						tables[metric].push(
							`| ${label} | ${v(minority)} | ${v(rest)} | ${mean(ratios).toFixed(3)} | ${sd(ratios).toFixed(3)} | ${Math.min(...ratios).toFixed(2)}..${Math.max(...ratios).toFixed(2)} |`,
						);
					} else {
						tables[metric].push(
							`| ${label} | ${metric === "purity" ? mean(minority).toFixed(3) : v(minority)} | ${metric === "purity" ? mean(rest).toFixed(3) : v(rest)} | ${mean(ratios).toFixed(3)} |`,
						);
					}
				}
			}
			const slopeOf = (metric: Metric, xs = logSize, ys = logRatio[metric]) => slope(xs, ys).toFixed(3);
			const small = logSize.map((x, index) => [x, index] as const).filter(([x]) => x < 0);
			const smallFit = (metric: Metric) =>
				slopeOf(
					metric,
					small.map(([x]) => x),
					small.map(([, index]) => logRatio[metric][index] ?? 0),
				);
			coefficients.push(
				`| ${layout} | ${slopeOf("visualSeparation")} | ${smallFit("visualSeparation")} | ${slopeOf("purity")} | ${smallFit("purity")} | ${slopeOf("gap")} | ${smallFit("gap")} |`,
			);
		}
		lines.push(
			"V_g (outside / inside distance):",
			...tables.visualSeparation,
			"",
			"Purity P_g (k=5), graph purity G_g = 0.9 for every cluster:",
			...tables.purity,
			"",
			"Gap (nearest non-member / median edge length):",
			...tables.gap,
		);
		lines.push(
			"",
			"Size coefficients: slope of ln(minority / rest) on ln(share_min / share_rest); 'minority < rest' keeps only sweep points where the minority is the smaller cluster.",
			"| Layout | V all | V minority<rest | P all | P minority<rest | gap all | gap minority<rest |",
			"| --- | --- | --- | --- | --- | --- | --- |",
			...coefficients,
		);
		console.log(
			`${lines.join("\n")}\nN=800, mean degree 6, cross share 0.1, 3 clusters, seeds ${SEEDS.join(",")}, ${((performance.now() - started) / 1000).toFixed(1)} s`,
		);
	},
	120_000,
);
