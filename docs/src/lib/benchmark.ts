import type { GraphraumData } from "@yggy-tech/graphraum";

export interface BenchmarkStatistics {
	coefficientOfVariation: number | null;
	count: number;
	max: number | null;
	mean: number | null;
	min: number | null;
	p50: number | null;
	p95: number | null;
	p99: number | null;
	standardDeviation: number | null;
}

export const BENCHMARK_NODE_COLORS = ["#226f54", "#347f63", "#469878", "#5caf8d", "#73c7a5"] as const;

export function summarize(samples: readonly number[]): BenchmarkStatistics {
	if (samples.some((sample) => !Number.isFinite(sample) || sample < 0))
		throw new Error("Benchmark samples must be finite, non-negative numbers.");
	if (samples.length === 0)
		return {
			coefficientOfVariation: null,
			count: 0,
			max: null,
			mean: null,
			min: null,
			p50: null,
			p95: null,
			p99: null,
			standardDeviation: null,
		};
	const sorted = samples.toSorted((left, right) => left - right);
	const percentile = (value: number) => sorted[Math.ceil((value / 100) * sorted.length) - 1] ?? null;
	const mean = sorted.reduce((total, sample) => total + sample, 0) / sorted.length;
	const standardDeviation = Math.sqrt(
		sorted.reduce((total, sample) => total + (sample - mean) ** 2, 0) / sorted.length,
	);
	return {
		coefficientOfVariation: mean === 0 ? 0 : standardDeviation / mean,
		count: sorted.length,
		max: sorted.at(-1) ?? null,
		mean,
		min: sorted[0] ?? null,
		p50: percentile(50),
		p95: percentile(95),
		p99: percentile(99),
		standardDeviation,
	};
}

export function effectivePixelRatio(devicePixelRatio: number, maxPixelRatio: number) {
	if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0)
		throw new Error("Device pixel ratio must be positive.");
	if (!Number.isFinite(maxPixelRatio) || maxPixelRatio <= 0) throw new Error("Maximum pixel ratio must be positive.");
	return Math.min(devicePixelRatio, maxPixelRatio);
}

export function createFixture(nodeCount: number): GraphraumData {
	if (!Number.isSafeInteger(nodeCount) || nodeCount < 2)
		throw new Error("A benchmark fixture needs at least two nodes.");
	const edgeCount = nodeCount * 3;
	const columns = Math.ceil(Math.sqrt(nodeCount));
	return {
		nodes: Array.from({ length: nodeCount }, (_, index) => {
			const row = Math.floor(index / columns);
			return {
				id: `node-${index}`,
				position: {
					x: (index % columns) * 12,
					y: row * 12,
					z: ((index * 17) % 101) - 50,
				},
				color: BENCHMARK_NODE_COLORS[(index * 7 + row * 3) % BENCHMARK_NODE_COLORS.length] ?? "#226f54",
				size: 2.5,
			};
		}),
		edges: Array.from({ length: edgeCount }, (_, index) => ({
			id: `edge-${index}`,
			source: `node-${index % nodeCount}`,
			target: `node-${(index * 97 + 13) % nodeCount}`,
		})),
	};
}
