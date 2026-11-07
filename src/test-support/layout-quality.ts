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
	/** Strip fixtures: per position along the strip, a spine node and a node across its width. */
	strip?: StripProbe;
}

/** `spine[c]` and `side[c]` are on the same cross-section c; `side - spine` is the local minor axis. */
export interface StripProbe {
	side: Uint32Array;
	spine: Uint32Array;
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

/**
 * Dense planted communities (held out from tuning): every node links to `meanDegree / 2` partners,
 * 90% inside its own group, so hubs are rare and groups are dense.
 */
export function denseCommunities(seed = 11, groupSizes = [160, 120, 100, 80, 60, 40], meanDegree = 20): QualityGraph {
	const random = seededRandom(seed);
	const nodeCount = groupSizes.reduce((sum, size) => sum + size, 0);
	const groups = new Uint32Array(nodeCount);
	const starts: number[] = [];
	let cursor = 0;
	for (const [group, size] of groupSizes.entries()) {
		starts.push(cursor);
		groups.fill(group, cursor, cursor + size);
		cursor += size;
	}
	const pairs: number[][] = [];
	for (let node = 0; node < nodeCount; node += 1) {
		const group = groups[node] ?? 0;
		for (let link = 0; link < meanDegree / 2; link += 1) {
			if (random() < 0.9) {
				pairs.push([node, (starts[group] ?? 0) + Math.floor(random() * (groupSizes[group] ?? 1))]);
			} else pairs.push([node, Math.floor(random() * nodeCount)]);
		}
	}
	const unique = pairs.filter(([source, target]) => source !== target);
	return { edges: packEdges(unique), groups, name: "dense communities", nodeCount };
}

/** Complete binary tree (held out from tuning); groups are the four subtrees two levels below the root. */
export function binaryTree(depth = 8): QualityGraph {
	const nodeCount = 2 ** depth - 1;
	const groups = new Uint32Array(nodeCount);
	const pairs: number[][] = [];
	for (let node = 1; node < nodeCount; node += 1) {
		pairs.push([(node - 1) >> 1, node]);
		let ancestor = node;
		while (ancestor > 6) ancestor = (ancestor - 1) >> 1;
		groups[node] = ancestor >= 3 ? ancestor - 3 : 0;
	}
	return { edges: packEdges(pairs), groups, name: "binary tree", nodeCount };
}

/** Random connected graph with about `meanDegree` edge ends per node, for step timing. */
export function sparseRandomGraph(nodeCount: number, seed = 7, meanDegree = 3): QualityGraph {
	const random = seededRandom(seed);
	const pairs: number[][] = [];
	for (let index = 1; index < nodeCount; index += 1) pairs.push([Math.floor(random() * index), index]);
	const extraEdges = Math.max(0, Math.round((nodeCount * meanDegree) / 2) - (nodeCount - 1));
	for (let index = 0; index < extraEdges; index += 1) {
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

/**
 * Stochastic block model for the size-bias measurement (#192): one minority cluster of `minorityShare`
 * of the nodes and `restClusters` equal clusters sharing the rest. Every cluster has the same share
 * `crossShare` of its edge endpoints leaving it (the same graph separation G_g = 1 - crossShare),
 * whatever its size. Leaving endpoints are paired across clusters by a largest-remaining-first random
 * matching, so the share is exact up to rounding and needs `minorityShare <= 0.5`.
 */
export function sizeSweepBlockModel(
	minorityShare: number,
	seed = 192,
	{ crossShare = 0.1, meanDegree = 6, nodeCount = 800, restClusters = 2 } = {},
): QualityGraph {
	const random = seededRandom(seed);
	const minorityCount = Math.max(2, Math.round(nodeCount * minorityShare));
	const restCount = Math.floor((nodeCount - minorityCount) / restClusters);
	const sizes = [minorityCount, ...Array.from({ length: restClusters }, () => restCount)];
	sizes[sizes.length - 1] = (sizes.at(-1) ?? 0) + nodeCount - sizes.reduce((sum, size) => sum + size, 0);
	const groups = new Uint32Array(nodeCount);
	const pairs: number[][] = [];
	const leaving: number[][] = sizes.map(() => []);
	let start = 0;
	for (const [group, size] of sizes.entries()) {
		groups.fill(group, start, start + size);
		const stubs = Math.round(meanDegree * size * crossShare);
		for (let stub = 0; stub < stubs; stub += 1) leaving[group]?.push(start + Math.floor(random() * size));
		const inside = Math.round((meanDegree * size - stubs) / 2);
		for (let edge = 0; edge < inside; edge += 1) {
			pairs.push([start + Math.floor(random() * size), start + Math.floor(random() * size)]);
		}
		start += size;
	}
	for (;;) {
		const open = leaving.map((stubs, group) => ({ group, stubs })).filter(({ stubs }) => stubs.length > 0);
		const largest = open.reduce((best, entry) => (entry.stubs.length > best.stubs.length ? entry : best), open[0]);
		const others = open.filter(({ group }) => group !== largest?.group);
		if (!largest || others.length === 0) break;
		const total = others.reduce((sum, { stubs }) => sum + stubs.length, 0);
		const pick = Math.floor(random() * total);
		let before = 0;
		const partner = others.find(({ stubs }) => {
			before += stubs.length;
			return pick < before;
		});
		const source = largest.stubs.splice(Math.floor(random() * largest.stubs.length), 1)[0];
		const target = partner?.stubs.splice(Math.floor(random() * partner.stubs.length), 1)[0];
		if (source !== undefined && target !== undefined) pairs.push([source, target]);
	}
	const unique = pairs.filter(([source, target]) => source !== target);
	return { edges: packEdges(unique), groups, name: `size sweep ${Math.round(minorityShare * 100)}%`, nodeCount };
}

export interface ClusterSeparation {
	/** Distance from the nearest member to the nearest non-member over the median edge length: the empty gap around the cluster. */
	gap: number;
	/** Share of the cluster's edge endpoints that stay inside it: the graph separation G_g of #192. */
	graphSeparation: number;
	nodeCount: number;
	/** Mean share of the members' `k` nearest layout neighbours that are members too: size-neutral, compare with `graphSeparation`. */
	purity: number;
	/** Mean distance from members to non-members over mean distance between members: V_g of #192. */
	visualSeparation: number;
}

/** G_g and V_g for every group of `graph`, indexed by group id. */
export function clusterSeparations(graph: QualityGraph, positions: Float32Array, k = 5): ClusterSeparation[] {
	const distances = distanceMatrix(positions, graph.nodeCount);
	const groupCount = Math.max(...graph.groups) + 1;
	const count = new Array<number>(groupCount).fill(0);
	const insidePairs = new Array<number>(groupCount).fill(0);
	const insideSum = new Array<number>(groupCount).fill(0);
	const outsideSum = new Array<number>(groupCount).fill(0);
	for (const group of graph.groups) count[group] = (count[group] ?? 0) + 1;
	for (let left = 0; left < graph.nodeCount; left += 1) {
		const leftGroup = graph.groups[left] ?? 0;
		for (let right = 0; right < graph.nodeCount; right += 1) {
			if (right === left) continue;
			const distance = distances[left * graph.nodeCount + right] ?? 0;
			if ((graph.groups[right] ?? 0) === leftGroup) {
				insideSum[leftGroup] = (insideSum[leftGroup] ?? 0) + distance;
				insidePairs[leftGroup] = (insidePairs[leftGroup] ?? 0) + 1;
			} else outsideSum[leftGroup] = (outsideSum[leftGroup] ?? 0) + distance;
		}
	}
	const endpoints = new Array<number>(groupCount).fill(0);
	const crossing = new Array<number>(groupCount).fill(0);
	for (let index = 0; index < graph.edges.length; index += 2) {
		const left = graph.groups[graph.edges[index] ?? 0] ?? 0;
		const right = graph.groups[graph.edges[index + 1] ?? 0] ?? 0;
		endpoints[left] = (endpoints[left] ?? 0) + 1;
		endpoints[right] = (endpoints[right] ?? 0) + 1;
		if (left !== right) {
			crossing[left] = (crossing[left] ?? 0) + 1;
			crossing[right] = (crossing[right] ?? 0) + 1;
		}
	}
	const purity = new Array<number>(groupCount).fill(0);
	const nearestOutside = new Array<number>(groupCount).fill(Number.POSITIVE_INFINITY);
	const nearest = new Float64Array(k);
	const nearestGroup = new Uint32Array(k);
	for (let node = 0; node < graph.nodeCount; node += 1) {
		const group = graph.groups[node] ?? 0;
		nearest.fill(Number.POSITIVE_INFINITY);
		for (let other = 0; other < graph.nodeCount; other += 1) {
			if (other === node) continue;
			const distance = distances[node * graph.nodeCount + other] ?? 0;
			if ((graph.groups[other] ?? 0) !== group) nearestOutside[group] = Math.min(nearestOutside[group] ?? 0, distance);
			if (distance >= (nearest[k - 1] ?? 0)) continue;
			let slot = k - 1;
			while (slot > 0 && distance < (nearest[slot - 1] ?? 0)) {
				nearest[slot] = nearest[slot - 1] ?? 0;
				nearestGroup[slot] = nearestGroup[slot - 1] ?? 0;
				slot -= 1;
			}
			nearest[slot] = distance;
			nearestGroup[slot] = graph.groups[other] ?? 0;
		}
		purity[group] = (purity[group] ?? 0) + nearestGroup.filter((neighbour) => neighbour === group).length / k;
	}
	const edgeLengths = [];
	for (let index = 0; index < graph.edges.length; index += 2) {
		edgeLengths.push(distances[(graph.edges[index] ?? 0) * graph.nodeCount + (graph.edges[index + 1] ?? 0)] ?? 0);
	}
	const medianEdge = edgeLengths.sort((left, right) => left - right)[Math.floor(edgeLengths.length / 2)] ?? 1;
	return count.map((nodeCount, group) => {
		const members = nodeCount;
		const outsidePairs = members * (graph.nodeCount - members);
		return {
			gap: (nearestOutside[group] ?? 0) / Math.max(medianEdge, 1e-9),
			graphSeparation: 1 - (crossing[group] ?? 0) / Math.max(1, endpoints[group] ?? 0),
			nodeCount,
			purity: (purity[group] ?? 0) / Math.max(1, members),
			visualSeparation:
				(outsideSum[group] ?? 0) /
				Math.max(1, outsidePairs) /
				Math.max((insideSum[group] ?? 0) / Math.max(1, insidePairs[group] ?? 0), 1e-9),
		};
	});
}

/**
 * Geometric reference for the size sweep: each group is a uniform disc of equal density (radius
 * proportional to the square root of its size), the discs sit in a row, group 0 first, with equal
 * gaps of `gapFactor` times the radius of a disc that holds a third of the nodes. A perfect layout
 * of equal-density groups would look like this, so its V_g shows what size does to V_g by geometry alone.
 */
export function discReference(graph: QualityGraph, seed = 1, gapFactor = 0.2): Float32Array {
	const random = seededRandom(seed);
	const groupCount = Math.max(...graph.groups) + 1;
	const sizes = new Array<number>(groupCount).fill(0);
	for (const group of graph.groups) sizes[group] = (sizes[group] ?? 0) + 1;
	const radius = sizes.map((size) => Math.sqrt(size));
	const gap = gapFactor * Math.sqrt(graph.nodeCount / 3);
	const centres: number[] = [];
	let cursor = 0;
	for (const r of radius) {
		centres.push(cursor + r);
		cursor += 2 * r + gap;
	}
	const positions = new Float32Array(graph.nodeCount * 3);
	for (let node = 0; node < graph.nodeCount; node += 1) {
		const group = graph.groups[node] ?? 0;
		const distance = (radius[group] ?? 0) * Math.sqrt(random());
		const angle = random() * 2 * Math.PI;
		positions.set([(centres[group] ?? 0) + distance * Math.cos(angle), distance * Math.sin(angle), 0], node * 3);
	}
	return positions;
}

/** Grid strip `rows` x `columns` (aspect `columns / rows`); node id is `row * columns + column`. */
export function gridStrip(rows: number, columns: number): QualityGraph {
	const pairs: number[][] = [];
	for (let row = 0; row < rows; row += 1) {
		for (let column = 0; column < columns; column += 1) {
			const node = row * columns + column;
			if (column + 1 < columns) pairs.push([node, node + 1]);
			if (row + 1 < rows) pairs.push([node, node + columns]);
		}
	}
	return {
		edges: packEdges(pairs),
		groups: new Uint32Array(rows * columns),
		name: `strip ${rows}x${columns} (aspect ${columns / rows})`,
		nodeCount: rows * columns,
		strip: {
			side: Uint32Array.from({ length: columns }, (_, column) => (rows - 1) * columns + column),
			spine: Uint32Array.from({ length: columns }, (_, column) => column),
		},
	};
}

/**
 * Swiss-roll style strip: a thin strip that winds `turns` times, with a bridge between the
 * neighbouring turns every `bridgeEvery` columns (what a nearest-neighbour graph of a rolled sheet
 * adds). A random start has to untangle the bridged layers; the intended layout is the unrolled strip.
 */
export function rolledStrip(rows = 4, columns = 200, turns = 2, bridgeEvery = 20): QualityGraph {
	const base = gridStrip(rows, columns);
	const pairs: number[][] = [];
	for (let index = 0; index < base.edges.length; index += 2)
		pairs.push([base.edges[index] ?? 0, base.edges[index + 1] ?? 0]);
	const turnLength = Math.floor(columns / turns);
	for (let column = 0; column + turnLength < columns; column += bridgeEvery) {
		for (const row of [0, rows - 1]) pairs.push([row * columns + column, row * columns + column + turnLength]);
	}
	return { ...base, edges: packEdges(pairs), name: `rolled strip ${rows}x${columns}, ${turns} turns` };
}

/** Path of `length` nodes with a two-node branch on one side of every third node. */
export function pathWithBranches(length = 600): QualityGraph {
	const pairs: number[][] = [];
	for (let node = 0; node + 1 < length; node += 1) pairs.push([node, node + 1]);
	const spine: number[] = [];
	const side: number[] = [];
	let next = length;
	for (let node = 1; node + 1 < length; node += 3) {
		pairs.push([node, next], [next, next + 1]);
		spine.push(node);
		side.push(next);
		next += 2;
	}
	return {
		edges: packEdges(pairs),
		groups: new Uint32Array(next),
		name: `path ${length} with side branches`,
		nodeCount: next,
		strip: { side: Uint32Array.from(side), spine: Uint32Array.from(spine) },
	};
}

/** Breadth-first hop distances from `source` (unreachable = -1). */
function hopDistances(neighbours: Set<number>[], source: number) {
	const distance = new Int32Array(neighbours.length).fill(-1);
	const queue = [source];
	distance[source] = 0;
	for (let head = 0; head < queue.length; head += 1) {
		const node = queue[head] ?? 0;
		for (const next of neighbours[node] ?? []) {
			if (distance[next] !== -1) continue;
			distance[next] = (distance[node] ?? 0) + 1;
			queue.push(next);
		}
	}
	return distance;
}

/**
 * Normalised stress against hop distances: the mean over node pairs of `(|xi - xj| / (s dij) - 1)^2`
 * with the scale `s` that minimises it. Scale free; 0 means the layout reproduces the graph metric.
 */
export function normalizedStress(graph: QualityGraph, positions: Float32Array) {
	const neighbours = adjacency(graph);
	const ratios: number[] = [];
	for (let source = 0; source < graph.nodeCount; source += 1) {
		const hops = hopDistances(neighbours, source);
		for (let target = source + 1; target < graph.nodeCount; target += 1) {
			const hop = hops[target] ?? -1;
			if (hop <= 0) continue;
			const length = Math.hypot(
				(positions[source * 3] ?? 0) - (positions[target * 3] ?? 0),
				(positions[source * 3 + 1] ?? 0) - (positions[target * 3 + 1] ?? 0),
				(positions[source * 3 + 2] ?? 0) - (positions[target * 3 + 2] ?? 0),
			);
			ratios.push(length / hop);
		}
	}
	// Minimising mean((r/s - 1)^2) over s gives s = mean(r^2) / mean(r).
	const meanRatio = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
	const meanSquare = ratios.reduce((sum, ratio) => sum + ratio * ratio, 0) / ratios.length;
	const scale = meanSquare / Math.max(meanRatio, 1e-12);
	return ratios.reduce((sum, ratio) => sum + (ratio / scale - 1) ** 2, 0) / ratios.length;
}

/**
 * Folds of a strip: walk the cross-sections in order, take the sign of cross(tangent, minor axis)
 * (the orientation of the local frame), and count sign flips. An unfolded strip has the same
 * orientation everywhere (0 folds); each fold reverses it. Near-degenerate frames are skipped.
 */
export function foldCount(probe: StripProbe, positions: Float32Array) {
	const at = (node: number, axis: number) => positions[node * 3 + axis] ?? 0;
	const length = probe.spine.length;
	let previous = 0;
	let folds = 0;
	// A tangent over a window of a fortieth of the strip ignores the jitter of single edges.
	const window = Math.max(1, Math.round(length / 40));
	for (let index = 0; index < length; index += 1) {
		const before = probe.spine[Math.max(0, index - window)] ?? 0;
		const after = probe.spine[Math.min(length - 1, index + window)] ?? 0;
		const spine = probe.spine[index] ?? 0;
		const side = probe.side[index] ?? 0;
		const tx = at(after, 0) - at(before, 0);
		const ty = at(after, 1) - at(before, 1);
		const mx = at(side, 0) - at(spine, 0);
		const my = at(side, 1) - at(spine, 1);
		const magnitude = Math.hypot(tx, ty) * Math.hypot(mx, my);
		if (magnitude < 1e-9) continue;
		const cross = (tx * my - ty * mx) / magnitude;
		if (Math.abs(cross) < 0.2) continue;
		const sign = Math.sign(cross);
		if (previous !== 0 && sign !== previous) folds += 1;
		previous = sign;
	}
	return folds;
}
