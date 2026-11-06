/**
 * Deterministic layout-quality fixtures and metrics for the force layout (#191).
 * Pure functions, seeded RNG, no DOM: the Vitest quality harness and ad hoc runs share them.
 */

export interface QualityGraph {
	edges: Uint32Array;
	/** Group per node: the planted block for SBM graphs, the star for star forests, one group for a chain. */
	groups: Uint32Array;
	name: string;
	nodeCount: number;
}

export interface LayoutQuality {
	/** Standard deviation over mean of the edge lengths: lower is more uniform. */
	edgeLengthCv: number;
	/** Mean share of each node's graph neighbours among its `degree` nearest layout neighbours: higher is better. */
	neighborhoodPreservation: number;
	/** Mean of each group's distance to non-members over distance between members (V_g in #192): higher is better. */
	separationRatio: number;
	/** Mean silhouette by planted group in layout space, from -1 to 1: higher is better. */
	silhouette: number;
}

/** Mulberry32: small, fast, and reproducible across runtimes. */
export function seededRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
	};
}

function packEdges(pairs: number[][]) {
	const edges = new Uint32Array(pairs.length * 2);
	for (const [index, [source, target]] of pairs.entries()) edges.set([source ?? 0, target ?? 0], index * 2);
	return edges;
}

/**
 * Stochastic block model shaped like a document graph: unequal groups, a few hub "documents" per group
 * that hold most of the group's edges, sparse member to member links, and a few cross-group edges.
 */
export function documentBlockModel(seed = 191, groupSizes = [110, 80, 60, 45, 35, 25, 15, 10, 8, 12]): QualityGraph {
	const random = seededRandom(seed);
	const nodeCount = groupSizes.reduce((sum, size) => sum + size, 0);
	const groups = new Uint32Array(nodeCount);
	const pairs: number[][] = [];
	const members: number[][] = [];
	let cursor = 0;
	for (const [group, size] of groupSizes.entries()) {
		const ids = Array.from({ length: size }, (_, offset) => cursor + offset);
		for (const id of ids) groups[id] = group;
		cursor += size;
		members.push(ids);
		const hubCount = Math.max(1, Math.round(size / 30));
		const hubs = ids.slice(0, hubCount);
		for (const id of ids.slice(hubCount)) {
			pairs.push([hubs[Math.floor(random() * hubCount)] ?? 0, id]);
			if (random() < 0.25) pairs.push([id, ids[Math.floor(random() * size)] ?? id]);
		}
		for (let left = 1; left < hubs.length; left += 1) pairs.push([hubs[0] ?? 0, hubs[left] ?? 0]);
	}
	const crossEdges = Math.round(nodeCount * 0.06);
	for (let edge = 0; edge < crossEdges; edge += 1) {
		const left = Math.floor(random() * groupSizes.length);
		const right = (left + 1 + Math.floor(random() * (groupSizes.length - 1))) % groupSizes.length;
		const source = members[left]?.[Math.floor(random() * (members[left]?.length ?? 1))] ?? 0;
		const target = members[right]?.[Math.floor(random() * (members[right]?.length ?? 1))] ?? 0;
		pairs.push([source, target]);
	}
	const unique = pairs.filter(([source, target]) => source !== target);
	return { edges: packEdges(unique), groups, name: "document SBM", nodeCount };
}

export function chain(nodeCount = 200): QualityGraph {
	const pairs = Array.from({ length: nodeCount - 1 }, (_, index) => [index, index + 1]);
	return { edges: packEdges(pairs), groups: new Uint32Array(nodeCount), name: "chain", nodeCount };
}

export function starForest(sizes = [60, 45, 35, 25, 18, 12, 8, 5]): QualityGraph {
	const nodeCount = sizes.reduce((sum, size) => sum + size, 0);
	const groups = new Uint32Array(nodeCount);
	const pairs: number[][] = [];
	let cursor = 0;
	for (const [star, size] of sizes.entries()) {
		for (let offset = 0; offset < size; offset += 1) {
			groups[cursor + offset] = star;
			if (offset > 0) pairs.push([cursor, cursor + offset]);
		}
		cursor += size;
	}
	return { edges: packEdges(pairs), groups, name: "star forest", nodeCount };
}

/** Sparse random graph (mean degree about 3) for step timing. */
export function sparseRandomGraph(nodeCount: number, seed = 7): QualityGraph {
	const random = seededRandom(seed);
	const pairs: number[][] = [];
	for (let index = 1; index < nodeCount; index += 1) pairs.push([Math.floor(random() * index), index]);
	for (let index = 0; index < nodeCount / 2; index += 1) {
		pairs.push([Math.floor(random() * nodeCount), Math.floor(random() * nodeCount)]);
	}
	return {
		edges: packEdges(pairs.filter(([source, target]) => source !== target)),
		groups: new Uint32Array(nodeCount),
		name: `random ${nodeCount}`,
		nodeCount,
	};
}

function distanceMatrix(positions: Float32Array, nodeCount: number) {
	const distances = new Float64Array(nodeCount * nodeCount);
	for (let left = 0; left < nodeCount; left += 1) {
		for (let right = left + 1; right < nodeCount; right += 1) {
			const dx = (positions[left * 3] ?? 0) - (positions[right * 3] ?? 0);
			const dy = (positions[left * 3 + 1] ?? 0) - (positions[right * 3 + 1] ?? 0);
			const dz = (positions[left * 3 + 2] ?? 0) - (positions[right * 3 + 2] ?? 0);
			const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
			distances[left * nodeCount + right] = distance;
			distances[right * nodeCount + left] = distance;
		}
	}
	return distances;
}

function adjacency(graph: QualityGraph) {
	const neighbours = Array.from({ length: graph.nodeCount }, () => new Set<number>());
	for (let index = 0; index < graph.edges.length; index += 2) {
		const source = graph.edges[index] ?? 0;
		const target = graph.edges[index + 1] ?? 0;
		neighbours[source]?.add(target);
		neighbours[target]?.add(source);
	}
	return neighbours;
}

function silhouetteAndSeparation(graph: QualityGraph, distances: Float64Array) {
	const groupCount = Math.max(...graph.groups) + 1;
	const sums = new Float64Array(groupCount);
	const sizes = new Uint32Array(groupCount);
	for (const group of graph.groups) sizes[group] += 1;
	let silhouette = 0;
	const inside = new Float64Array(groupCount);
	const outside = new Float64Array(groupCount);
	for (let node = 0; node < graph.nodeCount; node += 1) {
		sums.fill(0);
		for (let other = 0; other < graph.nodeCount; other += 1) {
			if (other !== node) sums[graph.groups[other] ?? 0] += distances[node * graph.nodeCount + other] ?? 0;
		}
		const own = graph.groups[node] ?? 0;
		const ownSize = (sizes[own] ?? 1) - 1;
		const a = ownSize > 0 ? (sums[own] ?? 0) / ownSize : 0;
		let b = Number.POSITIVE_INFINITY;
		let outsideSum = 0;
		for (let group = 0; group < groupCount; group += 1) {
			if (group === own || (sizes[group] ?? 0) === 0) continue;
			b = Math.min(b, (sums[group] ?? 0) / (sizes[group] ?? 1));
			outsideSum += sums[group] ?? 0;
		}
		if (ownSize > 0 && Number.isFinite(b)) silhouette += (b - a) / Math.max(a, b, 1e-9);
		inside[own] += a;
		outside[own] += outsideSum / Math.max(1, graph.nodeCount - (sizes[own] ?? 0));
	}
	let separation = 0;
	let counted = 0;
	for (let group = 0; group < groupCount; group += 1) {
		if ((sizes[group] ?? 0) < 2 || groupCount < 2) continue;
		separation += (outside[group] ?? 0) / Math.max(inside[group] ?? 0, 1e-9);
		counted += 1;
	}
	return { separationRatio: counted ? separation / counted : 0, silhouette: silhouette / graph.nodeCount };
}

function neighborhoodPreservation(graph: QualityGraph, distances: Float64Array) {
	const neighbours = adjacency(graph);
	const order = Array.from({ length: graph.nodeCount }, (_, index) => index);
	let total = 0;
	let counted = 0;
	for (let node = 0; node < graph.nodeCount; node += 1) {
		const graphNeighbours = neighbours[node];
		if (!graphNeighbours || graphNeighbours.size === 0) continue;
		const row = node * graph.nodeCount;
		const nearest = order
			.filter((other) => other !== node)
			.sort((left, right) => (distances[row + left] ?? 0) - (distances[row + right] ?? 0))
			.slice(0, graphNeighbours.size);
		total += nearest.filter((other) => graphNeighbours.has(other)).length / graphNeighbours.size;
		counted += 1;
	}
	return counted ? total / counted : 0;
}

function edgeLengthCv(graph: QualityGraph, distances: Float64Array) {
	const lengths = [];
	for (let index = 0; index < graph.edges.length; index += 2) {
		lengths.push(distances[(graph.edges[index] ?? 0) * graph.nodeCount + (graph.edges[index + 1] ?? 0)] ?? 0);
	}
	const mean = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
	const variance = lengths.reduce((sum, length) => sum + (length - mean) ** 2, 0) / lengths.length;
	return Math.sqrt(variance) / Math.max(mean, 1e-9);
}

export function measureLayout(graph: QualityGraph, positions: Float32Array): LayoutQuality {
	const distances = distanceMatrix(positions, graph.nodeCount);
	return {
		edgeLengthCv: edgeLengthCv(graph, distances),
		neighborhoodPreservation: neighborhoodPreservation(graph, distances),
		...silhouetteAndSeparation(graph, distances),
	};
}
