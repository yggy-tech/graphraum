export interface Aggregate {
	max: number | null;
	mean: number | null;
	median: number | null;
	min: number | null;
	/** Samples that were numbers. */
	n: number;
	/** Samples the browser could not provide, for example GPU time without the timer extension. */
	nullCount: number;
	p95: number | null;
}

/** Median, p95, min, max and counts; `null` samples are counted, never averaged in. */
export function aggregate(samples: readonly (number | null)[]): Aggregate {
	const values = samples.filter((sample): sample is number => sample !== null);
	if (values.some((value) => !Number.isFinite(value) || value < 0))
		throw new Error("Benchmark samples must be finite, non-negative numbers.");
	const sorted = values.toSorted((left, right) => left - right);
	const percentile = (fraction: number) => sorted[Math.ceil(fraction * sorted.length) - 1] ?? null;
	return {
		max: sorted.at(-1) ?? null,
		mean: sorted.length === 0 ? null : sorted.reduce((total, value) => total + value, 0) / sorted.length,
		median: percentile(0.5),
		min: sorted[0] ?? null,
		n: sorted.length,
		nullCount: samples.length - values.length,
		p95: percentile(0.95),
	};
}

/** Deterministic order for a given seed, so a run can be repeated with the same shuffle. */
export function shuffle<Item>(items: readonly Item[], seed: number): Item[] {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
	};
	const result = [...items];
	for (let index = result.length - 1; index > 0; index -= 1) {
		const other = Math.floor(next() * (index + 1));
		[result[index], result[other]] = [result[other] as Item, result[index] as Item];
	}
	return result;
}
