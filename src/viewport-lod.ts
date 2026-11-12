export type GraphraumLodLevel = "density" | "detail" | "overview";

/** Single source of truth for the density/overview/detail tier reported in diagnostics and used to drive edge LOD packing. */
export function resolveLodLevel(
	densityLodActive: boolean,
	edgeCandidateCount: number,
	visibleEdgeSegmentCount: number,
): GraphraumLodLevel {
	if (densityLodActive) return "density";
	return edgeCandidateCount > visibleEdgeSegmentCount ? "overview" : "detail";
}

/** Collects unique edges touching visible nodes, in first-seen order, without scanning the complete edge list. */
export function collectIncidentEdges(
	visibleNodeIndices: readonly number[],
	incidentEdgeIndices: readonly (readonly number[])[],
	edgeCount: number,
): readonly number[] {
	const seen = new Uint8Array(edgeCount);
	const edges: number[] = [];
	for (const nodeIndex of visibleNodeIndices) {
		for (const edgeIndex of incidentEdgeIndices[nodeIndex] ?? []) {
			if (seen[edgeIndex]) continue;
			seen[edgeIndex] = 1;
			edges.push(edgeIndex);
		}
	}
	return edges;
}

export interface EdgeBudgetOptions {
	/** Edges kept before anything else, up to the budget: selection, focus and hover. */
	pinned?: ReadonlySet<number>;
	/** Importance of an edge, higher first. Without it the budget keeps an even stride. */
	score?: (edgeIndex: number) => number;
}

/** Importance of an edge: the degree of its source plus the degree of its target. */
export function endpointDegreeScore(
	edgeNodeIndices: Uint32Array,
	incidentEdgeIndices: readonly (readonly number[])[],
): (edgeIndex: number) => number {
	return (edgeIndex) =>
		(incidentEdgeIndices[edgeNodeIndices[edgeIndex * 2] ?? 0]?.length ?? 0) +
		(incidentEdgeIndices[edgeNodeIndices[edgeIndex * 2 + 1] ?? 0]?.length ?? 0);
}

const SCORE_SCALE = 2 ** 24;

/** A fixed pseudo-random fraction of the edge index, so ties between equal scores spread over the layout. */
function tieBreak(edgeIndex: number) {
	return (Math.imul(edgeIndex + 1, 0x9e3779b1) >>> 8) % SCORE_SCALE;
}

/** The k-th largest value of `keys` (1-based), by quickselect on a copy. */
function kthLargest(keys: Float64Array, k: number) {
	const work = keys.slice();
	const target = k - 1;
	let low = 0;
	let high = work.length - 1;
	while (low < high) {
		const pivot = [work[low] ?? 0, work[(low + high) >>> 1] ?? 0, work[high] ?? 0].sort((a, b) => b - a)[1] ?? 0;
		let i = low;
		let j = high;
		while (i <= j) {
			while ((work[i] ?? 0) > pivot) i += 1;
			while ((work[j] ?? 0) < pivot) j -= 1;
			if (i <= j) {
				const swap = work[i] ?? 0;
				work[i] = work[j] ?? 0;
				work[j] = swap;
				i += 1;
				j -= 1;
			}
		}
		if (target <= j) high = j;
		else if (target >= i) low = i;
		else return work[target] ?? 0;
	}
	return work[target] ?? 0;
}

function evenStride(edgeIndices: readonly number[], maximum: number) {
	const step = edgeIndices.length / maximum;
	return Array.from({ length: maximum }, (_, index) => edgeIndices[Math.floor(index * step)]).filter(
		(edgeIndex): edgeIndex is number => edgeIndex !== undefined,
	);
}

/**
 * Applies a deterministic overview budget. Pinned edges come first, then the highest `score`
 * edges, with ties spread by a fixed hash of the edge index. An edge's rank never depends on the
 * other candidates, so panning only changes the edges at the cut. Kept edges stay in candidate order.
 */
export function applyEdgeBudget(
	edgeIndices: readonly number[],
	maximum: number,
	options: EdgeBudgetOptions = {},
): readonly number[] {
	if (!Number.isSafeInteger(maximum) || maximum < 1)
		throw new Error("Maximum visible edges must be a positive integer.");
	if (edgeIndices.length <= maximum) return edgeIndices;
	const { pinned, score } = options;
	if (!score && !pinned?.size) return evenStride(edgeIndices, maximum);
	const keys = new Float64Array(edgeIndices.length);
	for (const [position, edgeIndex] of edgeIndices.entries()) {
		keys[position] = pinned?.has(edgeIndex)
			? Number.POSITIVE_INFINITY
			: (score ? Math.max(0, score(edgeIndex)) : 0) * SCORE_SCALE + tieBreak(edgeIndex);
	}
	const threshold = kthLargest(keys, maximum);
	let tied = maximum - keys.reduce((count, key) => count + (key > threshold ? 1 : 0), 0);
	const kept: number[] = [];
	for (const [position, edgeIndex] of edgeIndices.entries()) {
		const key = keys[position] ?? 0;
		if (key > threshold) kept.push(edgeIndex);
		else if (key === threshold && tied > 0) {
			kept.push(edgeIndex);
			tied -= 1;
		}
	}
	return kept;
}

/**
 * Splits off edges that cover less than `minimumPixels` on screen. `positions` holds six floats
 * per edge (two endpoints, x and y used); pinned edges are never dropped.
 */
export function dropSubPixelEdges(
	edgeIndices: readonly number[],
	positions: Float32Array,
	worldUnitsPerPixel: number,
	minimumPixels: number,
	pinned?: ReadonlySet<number>,
): { kept: readonly number[]; skipped: number } {
	const limit = (minimumPixels * worldUnitsPerPixel) ** 2;
	const kept = edgeIndices.filter((edgeIndex) => {
		if (pinned?.has(edgeIndex)) return true;
		const base = edgeIndex * 6;
		const dx = (positions[base + 3] ?? 0) - (positions[base] ?? 0);
		const dy = (positions[base + 4] ?? 0) - (positions[base + 1] ?? 0);
		return dx * dx + dy * dy >= limit;
	});
	return { kept, skipped: edgeIndices.length - kept.length };
}

/** Keeps density LOD stable while camera movement hovers around the visible-node budget. */
export function shouldUseDensityLod(candidateCount: number, maximum: number, active: boolean) {
	if (!Number.isSafeInteger(candidateCount) || candidateCount < 0)
		throw new Error("Visible node candidate count must be a non-negative integer.");
	if (!Number.isSafeInteger(maximum) || maximum < 1)
		throw new Error("Maximum visible nodes must be a positive integer.");
	return candidateCount > maximum * (active ? 0.85 : 1.1);
}
