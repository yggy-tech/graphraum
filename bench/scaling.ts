import type { BenchReport } from "./report";
import type { BenchEnvironment } from "./types";

/** Node counts of the scaling ladder; edges are always 3x nodes. */
export const SCALING_SIZES = [1_000, 3_000, 10_000, 30_000, 100_000, 300_000] as const;

/** The cluster LOD series also run at one million nodes, where the plain renderer cannot draw everything. */
export const LOD_SCALING_SIZES = [...SCALING_SIZES, 1_000_000] as const;

/** 60 fps frame budget in milliseconds. */
export const FRAME_BUDGET_MS = 16.7;

export const SCALING_SCHEMA = "graphraum-scaling/1";

/** One chart: a metric of one case family, read from the cold or warm samples of every size. */
export interface ScalingSeriesSpec {
	/** Case family run at each size; its case ids are `scale-<caseSeries>-<nodes>`. */
	caseSeries: string;
	id: string;
	metric: string;
	phase: "cold" | "warm";
	/** Ladder sizes of this family; the default ladder when absent. */
	sizes?: readonly number[];
	title: string;
}

export const SCALING_SERIES: readonly ScalingSeriesSpec[] = [
	{ caseSeries: "pan2d", id: "pan2d", metric: "totalMs", phase: "warm", title: "2D pan, main-thread ms per frame" },
	{ caseSeries: "zoom2d", id: "zoom2d", metric: "totalMs", phase: "warm", title: "2D zoom, main-thread ms per frame" },
	{
		caseSeries: "orbit3d",
		id: "orbit3d-cpu",
		metric: "totalMs",
		phase: "warm",
		title: "3D orbit, main-thread ms per frame",
	},
	{ caseSeries: "orbit3d", id: "orbit3d-gpu", metric: "gpuMs", phase: "warm", title: "3D orbit, GPU ms per frame" },
	{
		caseSeries: "selection2d",
		id: "selection2d",
		metric: "totalMs",
		phase: "warm",
		title: "Selection change, main-thread ms",
	},
	{ caseSeries: "load", id: "load", metric: "loadMs", phase: "cold", title: "Data load: setData plus first frame, ms" },
	{ caseSeries: "layout", id: "layout", metric: "totalMs", phase: "cold", title: "Worker force layout, total ms" },
	{
		caseSeries: "lodpan2d",
		id: "lodpan2d",
		metric: "totalMs",
		phase: "warm",
		sizes: LOD_SCALING_SIZES,
		title: "2D pan with cluster LOD, main-thread ms per frame",
	},
	{
		caseSeries: "lodorbit3d",
		id: "lodorbit3d",
		metric: "totalMs",
		phase: "warm",
		sizes: LOD_SCALING_SIZES,
		title: "3D orbit with cluster LOD, main-thread ms per frame",
	},
	{
		caseSeries: "lodpan2d",
		id: "lodtree",
		metric: "treeBuildMs",
		phase: "cold",
		sizes: LOD_SCALING_SIZES,
		title: "Cluster tree build (main thread here; run it in a worker), ms",
	},
	{
		caseSeries: "layout",
		id: "layout-first-useful",
		metric: "firstUsefulFrameMs",
		phase: "cold",
		title: "Worker force layout, first useful frame ms",
	},
	{
		caseSeries: "layout-multilevel",
		id: "layout-multilevel",
		metric: "totalMs",
		phase: "cold",
		title: "Worker multilevel force layout, total ms",
	},
	{
		caseSeries: "layout-multilevel",
		id: "layout-multilevel-first-useful",
		metric: "firstUsefulFrameMs",
		phase: "cold",
		title: "Worker multilevel force layout, first useful frame ms",
	},
	{
		caseSeries: "layout-multilevel",
		id: "layout-multilevel-coarsen",
		metric: "coarsenMs",
		phase: "cold",
		title: "Multilevel layout, coarsening ms",
	},
	{
		caseSeries: "layout-multilevel",
		id: "layout-multilevel-coarsest",
		metric: "coarsestMs",
		phase: "cold",
		title: "Multilevel layout, coarsest layout ms",
	},
	{
		caseSeries: "layout-multilevel",
		id: "layout-multilevel-refine",
		metric: "refineMs",
		phase: "cold",
		title: "Multilevel layout, refinement ms",
	},
	{
		caseSeries: "layout-multilevel",
		id: "layout-multilevel-transfer",
		metric: "transferMs",
		phase: "cold",
		title: "Multilevel layout, edge transfer ms",
	},
];

export interface ScalingPoint {
	edges: number;
	max: number | null;
	median: number | null;
	min: number | null;
	n: number;
	nodes: number;
	p95: number | null;
	/** Why this size has no measurement (timed out, a smaller size was already over the time cap, not supported). */
	skipped?: string;
}

export interface ScalingSeries {
	id: string;
	points: ScalingPoint[];
	title: string;
	unit: "ms";
}

/** The file `bun run bench` writes next to the report and the HTML overlays. Bump the number on a breaking change. */
export interface ScalingFile {
	commit: string;
	environment: Pick<BenchEnvironment, "glRenderer" | "gpuTimer" | "softwareRenderer" | "userAgent">;
	generatedAt: string;
	/** Name of this result set in the chart legend, for example "main" or "grid-branch". */
	label: string;
	runs: number;
	schema: typeof SCALING_SCHEMA;
	series: ScalingSeries[];
}

export function isScalingFile(value: unknown): value is ScalingFile {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { schema?: unknown }).schema === SCALING_SCHEMA &&
		Array.isArray((value as { series?: unknown }).series)
	);
}

export function scalingCaseId(caseSeries: string, nodes: number) {
	return `scale-${caseSeries}-${nodes}`;
}

/**
 * Least-squares line through (ln nodes, ln ms). The slope is the scaling exponent: about 1 is linear,
 * above 1 grows faster than the graph, below 1 is sub-linear. Plain JS on purpose: the HTML report
 * embeds this function's source, so it must not call anything outside itself.
 */
export function fitLogLog(points: readonly { median: number | null; nodes: number }[]) {
	const usable = points.filter(
		(point) => point.median !== null && Number.isFinite(point.median) && point.median > 0 && point.nodes > 0,
	);
	if (usable.length < 2) return null;
	const xs = usable.map((point) => Math.log(point.nodes));
	const ys = usable.map((point) => Math.log(point.median as number));
	const meanX = xs.reduce((total, value) => total + value, 0) / xs.length;
	const meanY = ys.reduce((total, value) => total + value, 0) / ys.length;
	let covariance = 0;
	let variance = 0;
	for (let index = 0; index < xs.length; index += 1) {
		covariance += ((xs[index] as number) - meanX) * ((ys[index] as number) - meanY);
		variance += ((xs[index] as number) - meanX) ** 2;
	}
	if (variance === 0) return null;
	const exponent = covariance / variance;
	return { exponent, intercept: meanY - exponent * meanX };
}

/**
 * Node count where the median first reaches `limit`, interpolated on the log-log line between the two
 * measured sizes around it. `always` means even the smallest size is over the limit. Self-contained
 * for the same reason as {@link fitLogLog}.
 */
export function crossing(points: readonly { median: number | null; nodes: number }[], limit: number) {
	const usable = points
		.filter((point) => point.median !== null && (point.median as number) > 0)
		.toSorted((left, right) => left.nodes - right.nodes);
	const first = usable[0];
	if (!first) return null;
	if ((first.median as number) >= limit) return { kind: "always" as const, nodes: first.nodes };
	for (let index = 1; index < usable.length; index += 1) {
		const low = usable[index - 1];
		const high = usable[index];
		if (!low || !high || (high.median as number) < limit) continue;
		const share =
			(Math.log(limit) - Math.log(low.median as number)) /
			(Math.log(high.median as number) - Math.log(low.median as number));
		return {
			kind: "interpolated" as const,
			nodes: Math.exp(Math.log(low.nodes) + share * (Math.log(high.nodes) - Math.log(low.nodes))),
		};
	}
	return null;
}

export function describeExponent(exponent: number) {
	if (exponent < 0.15) return "flat";
	if (exponent < 0.85) return "sub-linear";
	if (exponent <= 1.15) return "linear";
	if (exponent <= 1.6) return "super-linear";
	return "steeper than n^1.6";
}

/** Folds a finished report into the scaling file: one point per ladder size and series, skipped sizes kept with a reason. */
export function buildScalingFile(
	report: BenchReport,
	label: string,
	skipped: ReadonlyMap<string, string>,
): ScalingFile {
	const series = SCALING_SERIES.map((spec): ScalingSeries => {
		const points = (spec.sizes ?? SCALING_SIZES).flatMap((nodes): ScalingPoint[] => {
			const id = scalingCaseId(spec.caseSeries, nodes);
			const entry = report.aggregates.find((item) => item.descriptor.id === id);
			if (!entry) return [];
			const stats = entry.metrics.find((item) => item.metric === spec.metric && item.phase === spec.phase)?.stats;
			const base = { edges: nodes * 3, nodes };
			if (!stats || stats.n === 0) {
				const reason = skipped.get(id) ?? (stats ? "no samples (metric unavailable in this browser)" : "not run");
				return [{ ...base, max: null, median: null, min: null, n: 0, p95: null, skipped: reason }];
			}
			return [{ ...base, max: stats.max, median: stats.median, min: stats.min, n: stats.n, p95: stats.p95 }];
		});
		return { id: spec.id, points, title: spec.title, unit: "ms" };
	}).filter((entry) => entry.points.length > 0);
	return {
		commit: report.commit,
		environment: {
			glRenderer: report.environment.glRenderer,
			gpuTimer: report.environment.gpuTimer,
			softwareRenderer: report.environment.softwareRenderer,
			userAgent: report.environment.userAgent,
		},
		generatedAt: report.generatedAt,
		label,
		runs: report.runs,
		schema: SCALING_SCHEMA,
		series,
	};
}
