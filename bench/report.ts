import { buildScalingFile, crossing, describeExponent, FRAME_BUDGET_MS, fitLogLog } from "./scaling";
import { type Aggregate, aggregate } from "./stats";
import { BENCH_GROUPS, type BenchEnvironment, type BenchGroup, type CaseDescriptor, type CaseRunResult } from "./types";

export interface CaseRuns {
	descriptor: CaseDescriptor;
	runs: readonly CaseRunResult[];
}

export interface BenchReportInput {
	browserVersion: string;
	cases: readonly CaseRuns[];
	commit: string;
	environment: BenchEnvironment;
	generatedAt: string;
	/** Execution order of "case#run" jobs, after shuffling. */
	order: readonly string[];
	runs: number;
	seed: number;
	/** Chromium switches the run used, so the GL backend choice is on record. */
	launchArgs: readonly string[];
}

export interface MetricAggregate {
	metric: string;
	phase: "cold" | "warm";
	stats: Aggregate;
}

export interface CaseAggregate {
	descriptor: CaseDescriptor;
	metrics: MetricAggregate[];
}

export interface BenchReport extends BenchReportInput {
	aggregates: CaseAggregate[];
}

/** Cold metrics aggregate one value per fresh page; warm metrics pool every sample from every run. */
export function aggregateCase({ descriptor, runs }: CaseRuns): CaseAggregate {
	const cold = new Map<string, (number | null)[]>();
	const warm = new Map<string, (number | null)[]>();
	for (const run of runs) {
		for (const [metric, value] of Object.entries(run.cold)) cold.set(metric, [...(cold.get(metric) ?? []), value]);
		for (const [metric, samples] of Object.entries(run.warm))
			warm.set(metric, [...(warm.get(metric) ?? []), ...samples]);
	}
	return {
		descriptor,
		metrics: [
			...[...cold].map(([metric, samples]) => ({ metric, phase: "cold" as const, stats: aggregate(samples) })),
			...[...warm].map(([metric, samples]) => ({ metric, phase: "warm" as const, stats: aggregate(samples) })),
		],
	};
}

export function buildReport(input: BenchReportInput): BenchReport {
	return { ...input, aggregates: input.cases.map(aggregateCase) };
}

interface Column {
	label: string;
	metric: string;
	phase: "cold" | "warm";
	stat: "max" | "median" | "min" | "p95";
}

const FRAME_COLUMNS: Column[] = [
	{ label: "camera step ms (median)", metric: "stepMs", phase: "warm", stat: "median" },
	{ label: "camera step ms (p95)", metric: "stepMs", phase: "warm", stat: "p95" },
	{ label: "render CPU ms (median)", metric: "cpuMs", phase: "warm", stat: "median" },
	{ label: "render CPU ms (p95)", metric: "cpuMs", phase: "warm", stat: "p95" },
	{ label: "GPU ms (median)", metric: "gpuMs", phase: "warm", stat: "median" },
	{ label: "frame interval ms (p95)", metric: "frameMs", phase: "warm", stat: "p95" },
];

/** Columns per table. Every case also lists its cold costs in the cold table. */
export const GROUP_COLUMNS: Record<BenchGroup, Column[]> = {
	frame: FRAME_COLUMNS,
	glow: FRAME_COLUMNS,
	layout: [
		{ label: "startup ms", metric: "startupMs", phase: "cold", stat: "median" },
		{ label: "transfer ms", metric: "transferMs", phase: "cold", stat: "median" },
		{ label: "compute ms", metric: "computeMs", phase: "cold", stat: "median" },
		{ label: "coarsen ms", metric: "coarsenMs", phase: "cold", stat: "median" },
		{ label: "coarsest ms", metric: "coarsestMs", phase: "cold", stat: "median" },
		{ label: "refine ms", metric: "refineMs", phase: "cold", stat: "median" },
		{ label: "first useful frame ms", metric: "firstUsefulFrameMs", phase: "cold", stat: "median" },
		{ label: "total ms", metric: "totalMs", phase: "cold", stat: "median" },
		{ label: "total ms (max)", metric: "totalMs", phase: "cold", stat: "max" },
	],
	orbit: FRAME_COLUMNS.filter((column) => column.metric !== "stepMs"),
	scaling: [],
	selection: [
		{ label: "call ms (median)", metric: "stepMs", phase: "warm", stat: "median" },
		{ label: "call ms (p95)", metric: "stepMs", phase: "warm", stat: "p95" },
		{ label: "render CPU ms (median)", metric: "cpuMs", phase: "warm", stat: "median" },
		{ label: "render CPU ms (p95)", metric: "cpuMs", phase: "warm", stat: "p95" },
		{ label: "GPU ms (median)", metric: "gpuMs", phase: "warm", stat: "median" },
		{ label: "call to next frame ms (p95)", metric: "frameMs", phase: "warm", stat: "p95" },
	],
};

const GROUP_TITLES: Record<BenchGroup, string> = {
	frame: "Per-frame cost under 2D pan/zoom and 3D camera moves",
	glow: "Glow halos (14 and 256 glow nodes)",
	layout: "Worker force layout (#147)",
	orbit: "3D auto-orbit",
	scaling: "Scaling ladder",
	selection: "Selection and edge hover (setSelection, setEdgeSelection)",
};

function format(value: number | null) {
	if (value === null) return "n/a";
	if (value >= 100) return value.toFixed(0);
	if (value >= 10) return value.toFixed(1);
	return value.toFixed(2);
}

function lookup(aggregateOf: CaseAggregate, column: Column) {
	const found = aggregateOf.metrics.find((entry) => entry.metric === column.metric && entry.phase === column.phase);
	return found ? found.stats[column.stat] : null;
}

function row(cells: readonly string[]) {
	return `| ${cells.join(" | ")} |`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]) {
	return [row(headers), row(headers.map(() => "---")), ...rows.map(row)].join("\n");
}

function sampleCount(aggregateOf: CaseAggregate, column: Column) {
	return (
		aggregateOf.metrics.find((entry) => entry.metric === column.metric && entry.phase === column.phase)?.stats.n ?? 0
	);
}

function renderScalingMarkdown(report: BenchReport): string[] {
	const file = buildScalingFile(report, report.commit, new Map());
	const lines = [
		`## ${GROUP_TITLES.scaling}`,
		"",
		"Edges are 3x nodes. Median and p95 in ms per size; the exponent is the slope of a log-log fit of the medians (about 1 is linear). Charts: the HTML report next to this file.",
		"",
	];
	for (const series of file.series) {
		const fit = fitLogLog(series.points);
		const cross = crossing(series.points, FRAME_BUDGET_MS);
		lines.push(
			`### ${series.title}`,
			"",
			table(
				["Nodes", "median ms", "p95 ms", "n", "note"],
				series.points.map((point) => [
					point.nodes.toLocaleString("en-US"),
					format(point.median),
					format(point.p95),
					String(point.n),
					point.skipped ?? "",
				]),
			),
			"",
			fit
				? `Scaling exponent ~${fit.exponent.toFixed(2)} (${describeExponent(fit.exponent)}). ${cross ? (cross.kind === "always" ? "Over 16.7 ms at every measured size." : `Crosses 16.7 ms at about ${Math.round(cross.nodes).toLocaleString("en-US")} nodes.`) : "Stays under 16.7 ms across the measured range."}`
				: "Too few points for a fit.",
			"",
		);
	}
	return lines;
}

export function renderMarkdown(report: BenchReport): string {
	const { environment } = report;
	const lines: string[] = [
		"# graphraum browser benchmark",
		"",
		"Absolute numbers are machine-specific. Compare two runs only when they come from the same machine, browser and GL renderer, and compare the medians together with the spread (p95, min, max).",
		"",
		table(
			["Field", "Value"],
			[
				["Generated", report.generatedAt],
				["Commit", report.commit],
				["Browser", `${report.browserVersion} (${environment.userAgent})`],
				["GL renderer", `${environment.glRenderer} (${environment.glVendor})`],
				["Software rasterizer", environment.softwareRenderer ? "yes, GPU timings are CPU timings" : "no"],
				["Chromium switches", report.launchArgs.length === 0 ? "none" : report.launchArgs.join(" ")],
				[
					"GPU timer (EXT_disjoint_timer_query_webgl2)",
					environment.gpuTimer ? "available" : "unavailable, GPU columns are n/a",
				],
				["Device pixel ratio / max pixel ratio", `${environment.devicePixelRatio} / ${environment.maxPixelRatio}`],
				["Viewport", `${environment.viewport.width} x ${environment.viewport.height} CSS px`],
				[
					"Protocol",
					`${report.runs} fresh-page runs per case in randomized order (seed ${report.seed}); cold = one value per run, warm = every frame sample from every run pooled`,
				],
			],
		),
		"",
	];
	for (const group of BENCH_GROUPS) {
		const members = report.aggregates.filter((entry) => entry.descriptor.group === group);
		if (members.length === 0) continue;
		if (group === "scaling") {
			lines.push(...renderScalingMarkdown(report));
			continue;
		}
		const columns = GROUP_COLUMNS[group];
		lines.push(
			`## ${GROUP_TITLES[group]}`,
			"",
			table(
				["Case", "Mode", "Nodes / edges", ...columns.map((column) => column.label), "n"],
				members.map((entry) => [
					entry.descriptor.title,
					entry.descriptor.mode.toUpperCase(),
					`${entry.descriptor.nodes.toLocaleString("en-US")} / ${entry.descriptor.edges.toLocaleString("en-US")}`,
					...columns.map((column) => format(lookup(entry, column))),
					String(columns[0] ? sampleCount(entry, columns[0]) : 0),
				]),
			),
			"",
		);
		if (group !== "layout") {
			lines.push(
				"Cold costs (first pass of each fresh page, median of runs, min to max):",
				"",
				table(
					["Case", "construct ms", "setData ms", "first frame ms", "first frame CPU ms"],
					members.map((entry) => [
						entry.descriptor.title,
						...["constructMs", "setDataMs", "firstFrameMs", "firstFrameCpuMs"].map((metric) => {
							const stats = entry.metrics.find((item) => item.metric === metric && item.phase === "cold")?.stats;
							return stats ? `${format(stats.median)} (${format(stats.min)} to ${format(stats.max)})` : "n/a";
						}),
					]),
				),
				"",
			);
		}
		lines.push(...members.map((entry) => `- ${entry.descriptor.title}: ${entry.descriptor.protocol}`), "");
	}
	lines.push(
		"Columns marked n/a had no samples. Frame interval is capped by the display refresh in headless Chromium; use the CPU and GPU columns to compare renderer work.",
		"",
	);
	return lines.join("\n");
}
