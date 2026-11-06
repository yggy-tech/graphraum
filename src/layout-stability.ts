import { computeForcePositions, type ForceLayoutRequest } from "./force-layout";

/** Options for {@link measureLayoutStability}. */
export interface LayoutStabilityOptions {
	/** Nearest neighbours compared per node, an integer from 1 to `nodeCount - 1`. Default 10. */
	neighbours?: number;
	/** Also measure a degree-preserving shuffled copy of the graph as the false-positive floor. Default `true`. */
	placebo?: boolean;
	/** Layout runs with different seeds, an integer from 2 to {@link MAX_STABILITY_SEEDS}. Default 5. */
	seeds?: number;
}

/** Stability of one cluster; see {@link measureLayoutStability}. */
export interface ClusterStability {
	id: number;
	/** Number of nodes with this cluster id. */
	size: number;
	/** Mean neighbourhood stability of the cluster's nodes, from 0 to 1. */
	stability: number;
	/** The same number on the shuffled graph, or `null` when `placebo` is `false`. */
	placeboStability: number | null;
}

/** Result of {@link measureLayoutStability}. */
export interface LayoutStability {
	clusters: ClusterStability[];
	/** Mean over all nodes, from 0 to 1. */
	overall: number;
	/** The shuffled-graph counterpart of `overall`, or `null` when `placebo` is `false`. */
	placeboOverall: number | null;
	/** The number of seeds and neighbours actually used. */
	neighbours: number;
	seeds: number;
}

export const MAX_STABILITY_SEEDS = 32;
/** The nearest-neighbour search is brute force, O(seeds * nodeCount^2); this bounds it. */
export const MAX_STABILITY_NODES = 5_000;

const DEFAULT_SEEDS = 5;
const DEFAULT_NEIGHBOURS = 10;
/** Double-edge swap attempts per edge for the placebo graph. */
const SWAPS_PER_EDGE = 10;

/** Mulberry32: small, fast and reproducible across runtimes. */
function seededRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
	};
}

function assertIntegerInRange(name: string, value: number, min: number, max: number) {
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer from ${min} to ${max}, got ${value}.`);
	}
}

/** Fisher-Yates permutation of `0..count-1`. */
function shuffledIndices(count: number, random: () => number) {
	const order = Uint32Array.from({ length: count }, (_, index) => index);
	for (let index = count - 1; index > 0; index -= 1) {
		const other = Math.floor(random() * (index + 1));
		const held = order[index] ?? 0;
		order[index] = order[other] ?? 0;
		order[other] = held;
	}
	return order;
}

/**
 * Rewires edges by double-edge swaps: (a-b, c-d) becomes (a-d, c-b). Every node keeps its degree. A swap
 * that would create a self-loop or a duplicate edge is skipped, so a simple graph stays simple.
 */
function degreePreservingShuffle(edges: Uint32Array, nodeCount: number, seed: number) {
	const shuffled = new Uint32Array(edges);
	const edgeCount = edges.length / 2;
	if (edgeCount < 2) return shuffled;
	const random = seededRandom(seed);
	const key = (left: number, right: number) => (left < right ? left * nodeCount + right : right * nodeCount + left);
	const present = new Map<number, number>();
	const count = (edgeKey: number, delta: number) => present.set(edgeKey, (present.get(edgeKey) ?? 0) + delta);
	for (let index = 0; index < edgeCount; index += 1) {
		count(key(shuffled[index * 2] ?? 0, shuffled[index * 2 + 1] ?? 0), 1);
	}
	for (let attempt = 0; attempt < edgeCount * SWAPS_PER_EDGE; attempt += 1) {
		const first = Math.floor(random() * edgeCount) * 2;
		const second = Math.floor(random() * edgeCount) * 2;
		if (first === second) continue;
		const a = shuffled[first] ?? 0;
		const b = shuffled[first + 1] ?? 0;
		const c = shuffled[second] ?? 0;
		const d = shuffled[second + 1] ?? 0;
		if (a === d || c === b) continue;
		if ((present.get(key(a, d)) ?? 0) > 0 || (present.get(key(c, b)) ?? 0) > 0) continue;
		count(key(a, b), -1);
		count(key(c, d), -1);
		count(key(a, d), 1);
		count(key(c, b), 1);
		shuffled[first + 1] = d;
		shuffled[second + 1] = b;
	}
	return shuffled;
}

/**
 * Lays the graph out with node ids relabelled by `seed`. The layout hashes the node index into its
 * starting position and its samples, so a relabelling is a different seed; positions are mapped back
 * to the original ids.
 */
function seededLayout(request: ForceLayoutRequest, edges: Uint32Array, seed: number) {
	const { nodeCount } = request;
	const label = shuffledIndices(nodeCount, seededRandom(seed));
	const relabelled = edges.map((node) => label[node] ?? 0);
	const positions = computeForcePositions({
		dimensions: request.dimensions,
		edges: relabelled,
		iterations: request.iterations,
		linkDistances: request.linkDistances,
		nodeCount,
		settings: request.settings,
		springStrengths: request.springStrengths,
	});
	const original = new Float32Array(nodeCount * 3);
	for (let node = 0; node < nodeCount; node += 1) {
		const from = (label[node] ?? 0) * 3;
		original.set(positions.subarray(from, from + 3), node * 3);
	}
	return original;
}

/** Sorted ids of each node's `k` nearest nodes (Euclidean, ties to the lower id), `k` per node, flat. */
function nearestNeighbours(positions: Float32Array, nodeCount: number, k: number) {
	const result = new Uint32Array(nodeCount * k);
	const bestIds = new Uint32Array(k);
	const bestDistances = new Float64Array(k);
	for (let node = 0; node < nodeCount; node += 1) {
		let filled = 0;
		const x = positions[node * 3] ?? 0;
		const y = positions[node * 3 + 1] ?? 0;
		const z = positions[node * 3 + 2] ?? 0;
		for (let other = 0; other < nodeCount; other += 1) {
			if (other === node) continue;
			const dx = x - (positions[other * 3] ?? 0);
			const dy = y - (positions[other * 3 + 1] ?? 0);
			const dz = z - (positions[other * 3 + 2] ?? 0);
			const distance = dx * dx + dy * dy + dz * dz;
			if (filled === k && distance >= (bestDistances[k - 1] ?? 0)) continue;
			let slot = filled < k ? filled : k - 1;
			while (slot > 0 && (bestDistances[slot - 1] ?? 0) > distance) {
				bestDistances[slot] = bestDistances[slot - 1] ?? 0;
				bestIds[slot] = bestIds[slot - 1] ?? 0;
				slot -= 1;
			}
			bestDistances[slot] = distance;
			bestIds[slot] = other;
			if (filled < k) filled += 1;
		}
		result.set(bestIds.slice().sort(), node * k);
	}
	return result;
}

/** Jaccard index of two sorted id lists of equal length `k`. */
function sortedJaccard(left: Uint32Array, leftStart: number, right: Uint32Array, rightStart: number, k: number) {
	let shared = 0;
	let i = 0;
	let j = 0;
	while (i < k && j < k) {
		const a = left[leftStart + i] ?? 0;
		const b = right[rightStart + j] ?? 0;
		if (a === b) {
			shared += 1;
			i += 1;
			j += 1;
		} else if (a < b) i += 1;
		else j += 1;
	}
	return shared / (2 * k - shared);
}

/** Per-node stability: mean Jaccard index of the node's neighbour set over every pair of runs. */
function nodeStabilities(request: ForceLayoutRequest, edges: Uint32Array, seeds: number, k: number) {
	const { nodeCount } = request;
	const runs = Array.from({ length: seeds }, (_, seed) =>
		nearestNeighbours(seededLayout(request, edges, seed + 1), nodeCount, k),
	);
	const scores = new Float64Array(nodeCount);
	const pairCount = (seeds * (seeds - 1)) / 2;
	for (let node = 0; node < nodeCount; node += 1) {
		let sum = 0;
		for (let left = 0; left < seeds; left += 1) {
			for (let right = left + 1; right < seeds; right += 1) {
				sum += sortedJaccard(runs[left] ?? new Uint32Array(), node * k, runs[right] ?? new Uint32Array(), node * k, k);
			}
		}
		scores[node] = sum / pairCount;
	}
	return scores;
}

function validate(request: ForceLayoutRequest & { clusters: Uint32Array }, seeds: number, neighbours: number) {
	const { clusters, edges, nodeCount } = request;
	assertIntegerInRange("nodeCount", nodeCount, 3, MAX_STABILITY_NODES);
	assertIntegerInRange("seeds", seeds, 2, MAX_STABILITY_SEEDS);
	assertIntegerInRange("neighbours", neighbours, 1, nodeCount - 1);
	if (edges.length % 2 !== 0) throw new Error("Force edges must contain source/target pairs.");
	if (clusters.length !== nodeCount) {
		throw new Error(`Cluster index count (${clusters.length}) must match node count (${nodeCount}).`);
	}
	for (const node of edges) {
		if (node >= nodeCount) throw new Error(`Edge endpoint ${node} is outside the node count ${nodeCount}.`);
	}
}

/**
 * Treats the one-shot force layout as a measuring instrument: how much of what a reader sees is the graph,
 * and how much is the seed? Runs `computeForcePositions()` `seeds` times, each with the node ids
 * relabelled by a different seeded permutation (the layout derives its starting positions and samples
 * from the node index, so this changes the seed without touching the layout code), and scores every node
 * by how stable its neighbourhood is.
 *
 * **Metric.** In each run a node's neighbourhood is its `neighbours` nearest nodes by layout distance.
 * A node's stability is the mean Jaccard index (shared / union) of its neighbourhood over every pair of
 * runs: 1 when the same nodes stay around it in every run, close to `neighbours / nodeCount` when its
 * surroundings are arbitrary. The metric is invariant to rotation, reflection, translation and uniform
 * scale, so only structure counts. A cluster's stability is the mean over its nodes; `overall` is the mean
 * over all nodes.
 *
 * **Placebo.** The same measurement on a degree-preserving shuffle of the graph (double-edge swaps with a
 * fixed seed), scored with the same cluster labels. The placebo has the same degrees but no community
 * structure, so its number is the stability a cluster gets for free. Read a cluster as meaningful only
 * when `stability` clearly exceeds `placeboStability`.
 *
 * `request.clusters` holds the labels to score. It is not passed to the layout: a cluster pull would make
 * the labels stable by construction. Other layout fields (`settings`, `iterations`, `linkDistances`,
 * `springStrengths`) are used as given. Node ids in `clusters` need not be dense.
 *
 * The one-shot `"classic"` style runs few steps and mostly keeps its seeded start, so it scores close to the
 * placebo on most graphs; measure with `layoutStyle: "edge-t"` to see graph structure.
 *
 * Cost: `seeds` layouts (twice with the placebo) plus a brute force nearest-neighbour search per run,
 * O(seeds * nodeCount^2). `nodeCount` is limited to {@link MAX_STABILITY_NODES}. The result is
 * deterministic: same input, same numbers.
 */
export function measureLayoutStability(
	request: ForceLayoutRequest & { clusters: Uint32Array },
	options: LayoutStabilityOptions = {},
): LayoutStability {
	const seeds = options.seeds ?? DEFAULT_SEEDS;
	const neighbours = options.neighbours ?? DEFAULT_NEIGHBOURS;
	const placebo = options.placebo ?? true;
	const { clusters, nodeCount } = request;
	// A graph too small for the default neighbourhood still deserves an answer; an explicit request does not.
	const k = options.neighbours === undefined ? Math.min(neighbours, nodeCount - 1) : neighbours;
	validate(request, seeds, k);

	const scores = nodeStabilities(request, request.edges, seeds, k);
	const placeboScores = placebo
		? nodeStabilities(request, degreePreservingShuffle(request.edges, nodeCount, 0x9e3779b9), seeds, k)
		: null;

	const sizes = new Map<number, number>();
	const sums = new Map<number, [number, number]>();
	for (let node = 0; node < nodeCount; node += 1) {
		const id = clusters[node] ?? 0;
		sizes.set(id, (sizes.get(id) ?? 0) + 1);
		const [sum, placeboSum] = sums.get(id) ?? [0, 0];
		sums.set(id, [sum + (scores[node] ?? 0), placeboSum + (placeboScores?.[node] ?? 0)]);
	}
	const mean = (values: Float64Array | null) =>
		values === null ? null : values.reduce((total, value) => total + value, 0) / nodeCount;
	return {
		clusters: [...sizes.keys()]
			.sort((left, right) => left - right)
			.map((id) => {
				const size = sizes.get(id) ?? 1;
				const [sum, placeboSum] = sums.get(id) ?? [0, 0];
				return { id, placeboStability: placebo ? placeboSum / size : null, size, stability: sum / size };
			}),
		neighbours: k,
		overall: mean(scores) ?? 0,
		placeboOverall: mean(placeboScores),
		seeds,
	};
}
