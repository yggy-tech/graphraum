/**
 * A spatial cluster tree over node positions: a quadtree in 2D and an octree in 3D, stored as flat
 * typed arrays so it can be built in a worker and posted to the page. Members of a cluster are
 * contiguous in `order`, so a cluster costs a range, not a list.
 *
 * Edges are aggregated bottom-up. A cluster lists its neighbours at its own tree depth, plus
 * leaves that sit shallower than it; a parent merges the lists of its children. A cut that mixes
 * depths therefore finds the weight between two of its clusters by looking at the deeper one.
 */

export interface ClusterTreeInput {
	/** 2 for x,y; 3 for x,y,z. */
	dimensions: 2 | 3;
	/** One pair of node indices per edge. */
	edges?: Uint32Array;
	/** Clusters at most this large are leaves, and a leaf shows its real nodes when it is zoomed in on. Default 16. */
	leafSize?: number;
	/** Each cluster keeps at most this many neighbours, the heaviest. Default 32. */
	maxNeighbors?: number;
	/** x,y or x,y,z per node. */
	positions: Float32Array | Float64Array;
	/** Optional weight per edge (default 1). */
	weights?: Float32Array | Float64Array;
}

export interface ClusterTree {
	/** Neighbour weights of cluster `c`: `adjacencyWeight[adjacencyStart[c] + i]`, for `i` below `adjacencyCount[c]`. */
	adjacencyCount: Uint32Array;
	adjacencyStart: Uint32Array;
	adjacencyTarget: Uint32Array;
	adjacencyWeight: Float32Array;
	/** Cluster centroids, `dimensions` floats each. */
	centroid: Float32Array;
	childCount: Uint32Array;
	/** The children of cluster `c` are `childStart[c] .. childStart[c] + childCount[c] - 1`. */
	childStart: Uint32Array;
	clusterCount: number;
	depth: Uint8Array;
	dimensions: 2 | 3;
	/** The leaf cluster of every node. */
	leafOf: Uint32Array;
	leafSize: number;
	memberCount: Uint32Array;
	/** Members of cluster `c` are `order[memberStart[c] .. memberStart[c] + memberCount[c] - 1]`. */
	memberStart: Uint32Array;
	/** Per node: its edges, as `nodeEdgeNeighbor` and `nodeEdgeIndex` entries from `nodeEdgeStart[n]` to `nodeEdgeStart[n + 1]`. */
	nodeCount: number;
	nodeEdgeIndex: Uint32Array;
	nodeEdgeNeighbor: Uint32Array;
	nodeEdgeStart: Uint32Array;
	/** Nodes sorted along the space-filling curve; every cluster is a range of it. */
	order: Uint32Array;
	/** -1 for the root, which is cluster 0. */
	parent: Int32Array;
	/** A copy of the positions the tree was built from. */
	positions: Float32Array;
	/** Radius of the sphere around the centroid that holds every member. */
	radius: Float32Array;
	/** Weight per edge, or null when every edge weighs 1. */
	edgeWeights: Float32Array | null;
}

const INDEX_BITS = 23;
const INDEX_RANGE = 2 ** INDEX_BITS;
const MAX_NODES = INDEX_RANGE;
const CODE_BITS = 30;

/** Interleaves the low `bitsPerAxis` bits of each coordinate, x lowest, into one Morton code. */
function mortonCode(coords: readonly number[], bitsPerAxis: number): number {
	const axes = coords.length;
	let code = 0;
	for (let bit = bitsPerAxis - 1; bit >= 0; bit -= 1) {
		for (let axis = axes - 1; axis >= 0; axis -= 1) {
			code = code * 2 + (((coords[axis] as number) >>> bit) & 1);
		}
	}
	return code;
}

function assertInput(input: ClusterTreeInput): { leafSize: number; maxNeighbors: number; nodeCount: number } {
	const { dimensions, edges, positions, weights } = input;
	if (dimensions !== 2 && dimensions !== 3) throw new Error("Cluster tree dimensions must be 2 or 3.");
	if (positions.length % dimensions !== 0) {
		throw new Error(`Cluster tree positions must hold ${dimensions} numbers per node.`);
	}
	const nodeCount = positions.length / dimensions;
	if (nodeCount < 1) throw new Error("A cluster tree needs at least one node.");
	if (nodeCount > MAX_NODES) throw new Error(`A cluster tree holds at most ${MAX_NODES} nodes.`);
	const leafSize = input.leafSize ?? 16;
	if (!Number.isSafeInteger(leafSize) || leafSize < 1)
		throw new Error("Cluster tree leafSize must be a positive integer.");
	const maxNeighbors = input.maxNeighbors ?? 32;
	if (!Number.isSafeInteger(maxNeighbors) || maxNeighbors < 1) {
		throw new Error("Cluster tree maxNeighbors must be a positive integer.");
	}
	for (const value of positions) {
		if (!Number.isFinite(value)) throw new Error("Cluster tree positions must be finite numbers.");
	}
	if (edges) {
		if (edges.length % 2 !== 0) throw new Error("Cluster tree edges must hold two node indices per edge.");
		for (const index of edges) {
			if (index >= nodeCount) throw new Error(`Cluster tree edge points at node ${index}, which does not exist.`);
		}
		if (weights && weights.length !== edges.length / 2) {
			throw new Error("Cluster tree weights must hold one number per edge.");
		}
	}
	return { leafSize, maxNeighbors, nodeCount };
}

/** Sorts the nodes along a Morton curve. Returns the node order and each sorted node's code. */
function sortAlongCurve(positions: Float32Array | Float64Array, dimensions: 2 | 3, nodeCount: number) {
	const bitsPerAxis = CODE_BITS / dimensions;
	const lows = new Array<number>(dimensions).fill(Number.POSITIVE_INFINITY);
	const highs = new Array<number>(dimensions).fill(Number.NEGATIVE_INFINITY);
	for (let node = 0; node < nodeCount; node += 1) {
		for (let axis = 0; axis < dimensions; axis += 1) {
			const value = positions[node * dimensions + axis] as number;
			if (value < (lows[axis] as number)) lows[axis] = value;
			if (value > (highs[axis] as number)) highs[axis] = value;
		}
	}
	const extent = Math.max(...highs.map((high, axis) => high - (lows[axis] as number)), Number.MIN_VALUE);
	const cells = 2 ** bitsPerAxis;
	const scale = (cells - 1) / extent;
	// Code and node index share one double: the code above, the index below, so a numeric sort orders both.
	const keys = new Float64Array(nodeCount);
	const coords = new Array<number>(dimensions).fill(0);
	for (let node = 0; node < nodeCount; node += 1) {
		for (let axis = 0; axis < dimensions; axis += 1) {
			coords[axis] = Math.min(
				cells - 1,
				Math.floor(((positions[node * dimensions + axis] as number) - (lows[axis] as number)) * scale),
			);
		}
		keys[node] = mortonCode(coords, bitsPerAxis) * INDEX_RANGE + node;
	}
	keys.sort();
	const order = new Uint32Array(nodeCount);
	const codes = new Uint32Array(nodeCount);
	for (let rank = 0; rank < nodeCount; rank += 1) {
		const key = keys[rank] as number;
		const code = Math.floor(key / INDEX_RANGE);
		codes[rank] = code;
		order[rank] = key - code * INDEX_RANGE;
	}
	return { bitsPerAxis, codes, order };
}

interface Skeleton {
	childCount: number[];
	childStart: number[];
	depth: number[];
	memberCount: number[];
	memberStart: number[];
	parent: number[];
}

/** Splits ranges of the sorted nodes by Morton digit, breadth first, so the children of a cluster get consecutive ids. */
function buildSkeleton(codes: Uint32Array, dimensions: 2 | 3, bitsPerAxis: number, leafSize: number): Skeleton {
	const total = codes.length;
	const skeleton: Skeleton = {
		childCount: [0],
		childStart: [0],
		depth: [0],
		memberCount: [total],
		memberStart: [0],
		parent: [-1],
	};
	const digitMask = 2 ** dimensions - 1;
	// The Morton level a cluster splits at: levels with a single occupied child are skipped.
	const levels = [0];
	for (let cluster = 0; cluster < skeleton.parent.length; cluster += 1) {
		const start = skeleton.memberStart[cluster] as number;
		const count = skeleton.memberCount[cluster] as number;
		if (count <= leafSize) continue;
		let level = levels[cluster] as number;
		let boundaries: number[] = [];
		for (; level < bitsPerAxis; level += 1) {
			const shift = (bitsPerAxis - 1 - level) * dimensions;
			boundaries = [start];
			let previous = ((codes[start] as number) >>> shift) & digitMask;
			for (let rank = start + 1; rank < start + count; rank += 1) {
				const digit = ((codes[rank] as number) >>> shift) & digitMask;
				if (digit !== previous) {
					boundaries.push(rank);
					previous = digit;
				}
			}
			if (boundaries.length > 1) break;
		}
		// Nodes in one finest cell cannot be split further: the cluster stays a (large) leaf.
		if (boundaries.length < 2) continue;
		skeleton.childStart[cluster] = skeleton.parent.length;
		skeleton.childCount[cluster] = boundaries.length;
		for (const [position, boundary] of boundaries.entries()) {
			const end = boundaries[position + 1] ?? start + count;
			skeleton.parent.push(cluster);
			skeleton.depth.push((skeleton.depth[cluster] as number) + 1);
			skeleton.memberStart.push(boundary);
			skeleton.memberCount.push(end - boundary);
			skeleton.childStart.push(0);
			skeleton.childCount.push(0);
			levels.push(level + 1);
		}
	}
	return skeleton;
}

/** Centroid and bounding radius of every cluster, children before parents. */
function computeShapes(
	skeleton: Skeleton,
	positions: Float32Array | Float64Array,
	order: Uint32Array,
	dimensions: 2 | 3,
) {
	const clusterCount = skeleton.parent.length;
	const centroid = new Float32Array(clusterCount * dimensions);
	const radius = new Float32Array(clusterCount);
	for (let cluster = clusterCount - 1; cluster >= 0; cluster -= 1) {
		const count = skeleton.memberCount[cluster] as number;
		const childCount = skeleton.childCount[cluster] as number;
		const base = cluster * dimensions;
		if (childCount === 0) {
			const start = skeleton.memberStart[cluster] as number;
			const sums = new Array<number>(dimensions).fill(0);
			for (let rank = start; rank < start + count; rank += 1) {
				for (let axis = 0; axis < dimensions; axis += 1) {
					sums[axis] = (sums[axis] as number) + (positions[(order[rank] as number) * dimensions + axis] as number);
				}
			}
			for (let axis = 0; axis < dimensions; axis += 1) centroid[base + axis] = (sums[axis] as number) / count;
			let reach = 0;
			for (let rank = start; rank < start + count; rank += 1) {
				let squared = 0;
				for (let axis = 0; axis < dimensions; axis += 1) {
					squared +=
						((positions[(order[rank] as number) * dimensions + axis] as number) - (centroid[base + axis] as number)) **
						2;
				}
				reach = Math.max(reach, squared);
			}
			radius[cluster] = Math.sqrt(reach);
			continue;
		}
		const first = skeleton.childStart[cluster] as number;
		for (let axis = 0; axis < dimensions; axis += 1) {
			let sum = 0;
			for (let child = first; child < first + childCount; child += 1) {
				sum += (centroid[child * dimensions + axis] as number) * (skeleton.memberCount[child] as number);
			}
			centroid[base + axis] = sum / count;
		}
		let reach = 0;
		for (let child = first; child < first + childCount; child += 1) {
			let squared = 0;
			for (let axis = 0; axis < dimensions; axis += 1) {
				squared += ((centroid[child * dimensions + axis] as number) - (centroid[base + axis] as number)) ** 2;
			}
			reach = Math.max(reach, Math.sqrt(squared) + (radius[child] as number));
		}
		radius[cluster] = reach;
	}
	return { centroid, radius };
}

/** The edges of every node in one flat list, both directions. */
function buildNodeEdges(nodeCount: number, edges: Uint32Array | undefined) {
	const edgeCount = edges ? edges.length / 2 : 0;
	const start = new Uint32Array(nodeCount + 1);
	for (let edge = 0; edge < edgeCount; edge += 1) {
		const source = edges?.[edge * 2] as number;
		const target = edges?.[edge * 2 + 1] as number;
		if (source === target) continue;
		start[source + 1] = (start[source + 1] as number) + 1;
		start[target + 1] = (start[target + 1] as number) + 1;
	}
	for (let node = 0; node < nodeCount; node += 1)
		start[node + 1] = (start[node + 1] as number) + (start[node] as number);
	const neighbor = new Uint32Array(start[nodeCount] as number);
	const index = new Uint32Array(start[nodeCount] as number);
	const fill = start.slice(0, nodeCount);
	for (let edge = 0; edge < edgeCount; edge += 1) {
		const source = edges?.[edge * 2] as number;
		const target = edges?.[edge * 2 + 1] as number;
		if (source === target) continue;
		const sourceSlot = fill[source] as number;
		fill[source] = sourceSlot + 1;
		neighbor[sourceSlot] = target;
		index[sourceSlot] = edge;
		const targetSlot = fill[target] as number;
		fill[target] = targetSlot + 1;
		neighbor[targetSlot] = source;
		index[targetSlot] = edge;
	}
	return { index, neighbor, start };
}

/** Aggregated neighbour lists, built from the leaves up. */
function aggregateEdges(
	skeleton: Skeleton,
	order: Uint32Array,
	nodeEdges: ReturnType<typeof buildNodeEdges>,
	edgeWeights: Float32Array | null,
	maxNeighbors: number,
) {
	const clusterCount = skeleton.parent.length;
	const nodeCount = order.length;
	const leafOf = new Uint32Array(nodeCount);
	for (let cluster = 0; cluster < clusterCount; cluster += 1) {
		if ((skeleton.childCount[cluster] as number) !== 0) continue;
		const start = skeleton.memberStart[cluster] as number;
		for (let rank = start; rank < start + (skeleton.memberCount[cluster] as number); rank += 1) {
			leafOf[order[rank] as number] = cluster;
		}
	}
	const adjacencyStart = new Uint32Array(clusterCount);
	const adjacencyCount = new Uint32Array(clusterCount);
	const targets: number[] = [];
	const weights: number[] = [];
	const scratch = new Map<number, number>();
	const add = (neighbor: number, weight: number) => scratch.set(neighbor, (scratch.get(neighbor) ?? 0) + weight);
	const flush = (cluster: number) => {
		let entries = [...scratch];
		scratch.clear();
		if (entries.length > maxNeighbors) {
			entries = entries.sort((left, right) => right[1] - left[1] || left[0] - right[0]).slice(0, maxNeighbors);
		}
		adjacencyStart[cluster] = targets.length;
		adjacencyCount[cluster] = entries.length;
		for (const [neighbor, weight] of entries) {
			targets.push(neighbor);
			weights.push(weight);
		}
	};
	// Children have larger ids than their parents, so walking downwards visits children first.
	for (let cluster = clusterCount - 1; cluster >= 0; cluster -= 1) {
		const childCount = skeleton.childCount[cluster] as number;
		if (childCount === 0) {
			const start = skeleton.memberStart[cluster] as number;
			for (let rank = start; rank < start + (skeleton.memberCount[cluster] as number); rank += 1) {
				const node = order[rank] as number;
				for (let slot = nodeEdges.start[node] as number; slot < (nodeEdges.start[node + 1] as number); slot += 1) {
					const neighborLeaf = leafOf[nodeEdges.neighbor[slot] as number] as number;
					if (neighborLeaf !== cluster) add(neighborLeaf, edgeWeights?.[nodeEdges.index[slot] as number] ?? 1);
				}
			}
		} else {
			const first = skeleton.childStart[cluster] as number;
			const level = skeleton.depth[cluster] as number;
			for (let child = first; child < first + childCount; child += 1) {
				const from = adjacencyStart[child] as number;
				for (let slot = from; slot < from + (adjacencyCount[child] as number); slot += 1) {
					let neighbor = targets[slot] as number;
					while ((skeleton.depth[neighbor] as number) > level) neighbor = skeleton.parent[neighbor] as number;
					if (neighbor !== cluster) add(neighbor, weights[slot] as number);
				}
			}
		}
		flush(cluster);
	}
	return {
		adjacencyCount,
		adjacencyStart,
		adjacencyTarget: Uint32Array.from(targets),
		adjacencyWeight: Float32Array.from(weights),
		leafOf,
	};
}

/** Builds the cluster tree. Run it in a worker for large graphs and post the result (see `clusterTreeTransferables`). */
export function buildClusterTree(input: ClusterTreeInput): ClusterTree {
	const { leafSize, maxNeighbors, nodeCount } = assertInput(input);
	const { dimensions, positions } = input;
	const { bitsPerAxis, codes, order } = sortAlongCurve(positions, dimensions, nodeCount);
	const skeleton = buildSkeleton(codes, dimensions, bitsPerAxis, leafSize);
	const { centroid, radius } = computeShapes(skeleton, positions, order, dimensions);
	const edgeWeights = input.weights ? Float32Array.from(input.weights) : null;
	const nodeEdges = buildNodeEdges(nodeCount, input.edges);
	const aggregated = aggregateEdges(skeleton, order, nodeEdges, edgeWeights, maxNeighbors);
	return {
		adjacencyCount: aggregated.adjacencyCount,
		adjacencyStart: aggregated.adjacencyStart,
		adjacencyTarget: aggregated.adjacencyTarget,
		adjacencyWeight: aggregated.adjacencyWeight,
		centroid,
		childCount: Uint32Array.from(skeleton.childCount),
		childStart: Uint32Array.from(skeleton.childStart),
		clusterCount: skeleton.parent.length,
		depth: Uint8Array.from(skeleton.depth),
		dimensions,
		edgeWeights,
		leafOf: aggregated.leafOf,
		leafSize,
		memberCount: Uint32Array.from(skeleton.memberCount),
		memberStart: Uint32Array.from(skeleton.memberStart),
		nodeCount,
		nodeEdgeIndex: nodeEdges.index,
		nodeEdgeNeighbor: nodeEdges.neighbor,
		nodeEdgeStart: nodeEdges.start,
		order,
		parent: Int32Array.from(skeleton.parent),
		positions: Float32Array.from(positions),
		radius,
	};
}

/** The buffers of a tree, for the transfer list of `postMessage` so a worker hands the tree over without copying it. */
export function clusterTreeTransferables(tree: ClusterTree): ArrayBuffer[] {
	return Object.values(tree)
		.filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
		.map((view) => view.buffer as ArrayBuffer);
}

/** The node indices in cluster `cluster`. */
export function clusterMembers(tree: ClusterTree, cluster: number): Uint32Array {
	if (!Number.isInteger(cluster) || cluster < 0 || cluster >= tree.clusterCount) {
		throw new Error(`Cluster ${cluster} does not exist.`);
	}
	const start = tree.memberStart[cluster] as number;
	return tree.order.subarray(start, start + (tree.memberCount[cluster] as number));
}
