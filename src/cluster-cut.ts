import type { ClusterTree } from "./cluster-tree";

/** The camera and canvas a cut is made for. 3D assumes the camera graphraum creates: 45 degrees, y up. */
export type ClusterView =
	| { center: { x: number; y: number }; height: number; mode: "2d"; visibleHeight: number; width: number }
	| {
			fovDegrees?: number;
			height: number;
			mode: "3d";
			position: { x: number; y: number; z: number };
			target: { x: number; y: number; z: number };
			width: number;
	  };

export interface ClusterCutOptions {
	/** Share of the viewport kept around it, so clusters just off screen are still there when the camera moves. Default 0.1. */
	cullMargin?: number;
	/** At most this many edges are drawn. Default 8000. */
	maxDrawnEdges?: number;
	/** Clusters plus real nodes in the cut never pass this. Default 4000. */
	maxDrawnNodes?: number;
	/** A cluster whose projected radius is below this many pixels is drawn as one glyph. Default 10. */
	pixelThreshold?: number;
}

export interface ClusterCut {
	/** Deepest tree depth among the cut clusters. */
	cutDepth: number;
	/** Edge candidates before `maxDrawnEdges`. */
	edgeCandidates: number;
	/** Original edge index of a real edge, or -1 for an aggregate. */
	edgeIndex: Int32Array;
	/** Cut element at either end: `clusters.length + i` is `nodes[i]`. */
	edgeSource: Uint32Array;
	edgeTarget: Uint32Array;
	edgeWeight: Float32Array;
	/** Clusters drawn as one glyph. */
	clusters: Uint32Array;
	/** Nodes drawn as themselves. */
	nodes: Uint32Array;
}

export const DEFAULT_CLUSTER_CUT_OPTIONS = {
	cullMargin: 0.1,
	maxDrawnEdges: 8_000,
	maxDrawnNodes: 4_000,
	pixelThreshold: 10,
} as const;

/** A leaf of up to this many times `leafSize` members may show its real nodes. */
const LEAF_EXPAND_FACTOR = 4;
const CULLED = -1;

/** Projected radius in pixels of a sphere, `CULLED` when it is off screen, infinity when the camera is inside it. */
export type Projector = (x: number, y: number, z: number, radius: number) => number;

function normalized(x: number, y: number, z: number): [number, number, number] {
	const length = Math.hypot(x, y, z) || 1;
	return [x / length, y / length, z / length];
}

export function createProjector(view: ClusterView, cullMargin: number): Projector {
	const aspect = Math.max(view.width, 1) / Math.max(view.height, 1);
	if (view.mode === "2d") {
		const halfHeight = view.visibleHeight / 2;
		const halfWidth = halfHeight * aspect;
		const pixelsPerUnit = Math.max(view.height, 1) / view.visibleHeight;
		const marginX = halfWidth * (1 + cullMargin);
		const marginY = halfHeight * (1 + cullMargin);
		return (x, y, _z, radius) =>
			Math.abs(x - view.center.x) > marginX + radius || Math.abs(y - view.center.y) > marginY + radius
				? CULLED
				: radius * pixelsPerUnit;
	}
	const { position, target } = view;
	const [fx, fy, fz] = normalized(target.x - position.x, target.y - position.y, target.z - position.z);
	// Looking straight along y, any horizontal axis works as the reference.
	const [rx, ry, rz] = Math.hypot(fz, fx) < 1e-6 ? [1, 0, 0] : normalized(fz, 0, -fx);
	const ux = ry * fz - rz * fy;
	const uy = rz * fx - rx * fz;
	const uz = rx * fy - ry * fx;
	const tanY = Math.tan(((view.fovDegrees ?? 45) * Math.PI) / 360);
	const tanX = tanY * aspect;
	const slopeX = tanX * (1 + cullMargin);
	const slopeY = tanY * (1 + cullMargin);
	const normX = Math.sqrt(1 + slopeX * slopeX);
	const normY = Math.sqrt(1 + slopeY * slopeY);
	const halfHeightPixels = Math.max(view.height, 1) / 2;
	return (x, y, z, radius) => {
		const dx = x - position.x;
		const dy = y - position.y;
		const dz = z - position.z;
		const depth = dx * fx + dy * fy + dz * fz;
		if (depth + radius <= 0) return CULLED;
		if (
			(Math.abs(dx * rx + dy * ry + dz * rz) - depth * slopeX) / normX > radius ||
			(Math.abs(dx * ux + dy * uy + dz * uz) - depth * slopeY) / normY > radius
		) {
			return CULLED;
		}
		return depth <= radius ? Number.POSITIVE_INFINITY : (radius * halfHeightPixels) / (depth * tanY);
	};
}

/** A max-heap of cluster ids keyed by projected radius. */
class ClusterHeap {
	private readonly ids: number[] = [];
	private readonly keys: number[] = [];

	get size() {
		return this.ids.length;
	}

	push(id: number, key: number) {
		let slot = this.ids.length;
		this.ids.push(id);
		this.keys.push(key);
		while (slot > 0) {
			const up = (slot - 1) >> 1;
			if ((this.keys[up] as number) >= key) break;
			this.ids[slot] = this.ids[up] as number;
			this.keys[slot] = this.keys[up] as number;
			slot = up;
		}
		this.ids[slot] = id;
		this.keys[slot] = key;
	}

	peekKey() {
		return this.keys[0] ?? Number.NEGATIVE_INFINITY;
	}

	pop(): number {
		const top = this.ids[0] as number;
		const id = this.ids.pop() as number;
		const key = this.keys.pop() as number;
		const size = this.ids.length;
		if (size === 0) return top;
		let slot = 0;
		for (;;) {
			let child = slot * 2 + 1;
			if (child >= size) break;
			if (child + 1 < size && (this.keys[child + 1] as number) > (this.keys[child] as number)) child += 1;
			if ((this.keys[child] as number) <= key) break;
			this.ids[slot] = this.ids[child] as number;
			this.keys[slot] = this.keys[child] as number;
			slot = child;
		}
		this.ids[slot] = id;
		this.keys[slot] = key;
		return top;
	}

	drain(): number[] {
		return this.ids.splice(0);
	}
}

function resolveOptions(options: ClusterCutOptions) {
	const resolved = { ...DEFAULT_CLUSTER_CUT_OPTIONS, ...options };
	if (!Number.isFinite(resolved.pixelThreshold) || resolved.pixelThreshold <= 0) {
		throw new Error("Cluster LOD pixelThreshold must be a positive number.");
	}
	if (!Number.isFinite(resolved.cullMargin) || resolved.cullMargin < 0) {
		throw new Error("Cluster LOD cullMargin must be zero or more.");
	}
	for (const name of ["maxDrawnNodes", "maxDrawnEdges"] as const) {
		if (!Number.isSafeInteger(resolved[name]) || resolved[name] < 1) {
			throw new Error(`Cluster LOD ${name} must be a positive integer.`);
		}
	}
	return resolved;
}

interface EdgeCandidates {
	index: number[];
	real: boolean[];
	source: number[];
	target: number[];
	weight: number[];
}

/** The k-th largest of `values` (1-based), by sorting a typed copy, which is native and fast. */
function kthHeaviest(values: readonly number[], k: number): number {
	const sorted = Float32Array.from(values).sort();
	return sorted[sorted.length - k] as number;
}

/** Keeps the heaviest edges. Edges between real nodes get half the budget first, so detail survives next to heavy aggregates. */
function budgetEdges(candidates: EdgeCandidates, budget: number): number[] {
	const total = candidates.weight.length;
	const all = Array.from({ length: total }, (_, position) => position);
	if (total <= budget) return all;
	const real = all.filter((position) => candidates.real[position]);
	const aggregates = all.filter((position) => !candidates.real[position]);
	const realShare = Math.min(real.length, Math.max(budget - aggregates.length, Math.floor(budget / 2)));
	const aggregateShare = Math.min(aggregates.length, budget - realShare);
	const heaviest = (positions: number[], share: number) => {
		if (share >= positions.length) return positions;
		if (share <= 0) return [];
		const weights = positions.map((position) => candidates.weight[position] as number);
		const threshold = kthHeaviest(weights, share);
		const above = positions.filter((position) => (candidates.weight[position] as number) > threshold);
		let ties = share - above.length;
		const tied = positions.filter((position) => candidates.weight[position] === threshold && ties-- > 0);
		return [...above, ...tied];
	};
	return [...heaviest(real, realShare), ...heaviest(aggregates, aggregateShare)];
}

/**
 * Prepares cuts of one tree. The returned function picks, for a view, the clusters and real nodes
 * to draw, and the edges between them. Reuse it across frames: it keeps its scratch buffers.
 */
export function createClusterCutter(tree: ClusterTree) {
	const stamp = new Uint32Array(tree.clusterCount);
	const elementOf = new Uint32Array(tree.clusterCount);
	let token = 0;

	return (view: ClusterView, cutOptions: ClusterCutOptions = {}): ClusterCut => {
		const options = resolveOptions(cutOptions);
		if (view.mode !== (tree.dimensions === 2 ? "2d" : "3d")) {
			throw new Error(`A ${tree.dimensions}D cluster tree needs a ${tree.dimensions === 2 ? "2d" : "3d"} view.`);
		}
		const project = createProjector(view, options.cullMargin);
		const dims = tree.dimensions;
		const clusterRadius = (cluster: number) => {
			const base = cluster * dims;
			return project(
				tree.centroid[base] as number,
				tree.centroid[base + 1] as number,
				dims === 3 ? (tree.centroid[base + 2] as number) : 0,
				tree.radius[cluster] as number,
			);
		};
		const nodeVisible = (node: number) =>
			project(
				tree.positions[node * dims] as number,
				tree.positions[node * dims + 1] as number,
				dims === 3 ? (tree.positions[node * dims + 2] as number) : 0,
				0,
			) !== CULLED;

		const clusters: number[] = [];
		const nodes: number[] = [];
		const heap = new ClusterHeap();
		const rootRadius = clusterRadius(0);
		if (rootRadius !== CULLED) heap.push(0, rootRadius);
		while (heap.size > 0) {
			if (heap.peekKey() <= options.pixelThreshold) break;
			const cluster = heap.pop();
			const childCount = tree.childCount[cluster] as number;
			const isLeaf = childCount === 0;
			const members = tree.memberCount[cluster] as number;
			if (isLeaf && members > tree.leafSize * LEAF_EXPAND_FACTOR) {
				clusters.push(cluster);
				continue;
			}
			const first = tree.childStart[cluster] as number;
			const children: { id: number; radius: number }[] = [];
			const realNodes: number[] = [];
			if (isLeaf) {
				const start = tree.memberStart[cluster] as number;
				for (let rank = start; rank < start + members; rank += 1) {
					const node = tree.order[rank] as number;
					if (nodeVisible(node)) realNodes.push(node);
				}
			} else {
				for (let child = first; child < first + childCount; child += 1) {
					if ((tree.memberCount[child] as number) === 1) {
						const node = tree.order[tree.memberStart[child] as number] as number;
						if (nodeVisible(node)) realNodes.push(node);
						continue;
					}
					const radius = clusterRadius(child);
					if (radius !== CULLED) children.push({ id: child, radius });
				}
			}
			const used = clusters.length + nodes.length + heap.size;
			if (used + children.length + realNodes.length > options.maxDrawnNodes) {
				clusters.push(cluster);
				continue;
			}
			for (const child of children) heap.push(child.id, child.radius);
			nodes.push(...realNodes);
		}
		clusters.push(...heap.drain());

		return finishCut(tree, clusters, nodes, options.maxDrawnEdges);
	};

	function finishCut(tree: ClusterTree, clusters: number[], nodes: number[], maxDrawnEdges: number): ClusterCut {
		token += 1;
		let cutDepth = 0;
		for (const [element, cluster] of clusters.entries()) {
			stamp[cluster] = token;
			elementOf[cluster] = element;
			cutDepth = Math.max(cutDepth, tree.depth[cluster] as number);
		}
		const realElement = new Map(nodes.map((node, position) => [node, clusters.length + position]));
		const ownerOfCluster = (start: number) => {
			for (let cluster = start; cluster >= 0; cluster = tree.parent[cluster] as number) {
				if (stamp[cluster] === token) return elementOf[cluster] as number;
			}
			return -1;
		};
		const elementCount = clusters.length + nodes.length;
		const candidates: EdgeCandidates = { index: [], real: [], source: [], target: [], weight: [] };
		// Weight per other element while one element is scanned; `touched` lists the ones to emit and reset.
		const accumulated = new Float64Array(elementCount);
		const touched: number[] = [];
		const emitAggregates = (element: number) => {
			for (const other of touched) {
				candidates.index.push(-1);
				candidates.real.push(false);
				candidates.source.push(element);
				candidates.target.push(other);
				candidates.weight.push(accumulated[other] as number);
				accumulated[other] = 0;
			}
			touched.length = 0;
		};
		const accumulate = (owner: number, weight: number) => {
			if (accumulated[owner] === 0) touched.push(owner);
			accumulated[owner] = (accumulated[owner] as number) + weight;
		};

		for (const [element, cluster] of clusters.entries()) {
			const from = tree.adjacencyStart[cluster] as number;
			const depth = tree.depth[cluster] as number;
			for (let slot = from; slot < from + (tree.adjacencyCount[cluster] as number); slot += 1) {
				const owner = ownerOfCluster(tree.adjacencyTarget[slot] as number);
				if (owner < 0 || owner === element) continue;
				const ownerDepth = tree.depth[clusters[owner] as number] as number;
				// A leaf lists neighbours of any depth, and clusters of one depth list each other: the deeper
				// side of a pair, or the lower element at equal depth, counts it. Lists cut to `maxNeighbors`
				// can be one-sided, which drops the lighter of such pairs.
				if (ownerDepth > depth || (ownerDepth === depth && owner < element)) continue;
				accumulate(owner, tree.adjacencyWeight[slot] as number);
			}
			emitAggregates(element);
		}
		for (const [position, node] of nodes.entries()) {
			const element = clusters.length + position;
			for (let slot = tree.nodeEdgeStart[node] as number; slot < (tree.nodeEdgeStart[node + 1] as number); slot += 1) {
				const neighbor = tree.nodeEdgeNeighbor[slot] as number;
				const edge = tree.nodeEdgeIndex[slot] as number;
				const weight = tree.edgeWeights?.[edge] ?? 1;
				const other = realElement.get(neighbor);
				if (other !== undefined) {
					if (node < neighbor) {
						candidates.index.push(edge);
						candidates.real.push(true);
						candidates.source.push(element);
						candidates.target.push(other);
						candidates.weight.push(weight);
					}
					continue;
				}
				const owner = ownerOfCluster(tree.leafOf[neighbor] as number);
				if (owner >= 0) accumulate(owner, weight);
			}
			emitAggregates(element);
		}

		const kept = budgetEdges(candidates, maxDrawnEdges);
		return {
			clusters: Uint32Array.from(clusters),
			cutDepth,
			edgeCandidates: candidates.weight.length,
			edgeIndex: Int32Array.from(kept, (position) => candidates.index[position] as number),
			edgeSource: Uint32Array.from(kept, (position) => candidates.source[position] as number),
			edgeTarget: Uint32Array.from(kept, (position) => candidates.target[position] as number),
			edgeWeight: Float32Array.from(kept, (position) => candidates.weight[position] as number),
			nodes: Uint32Array.from(nodes),
		};
	}
}
