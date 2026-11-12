import { type ClusterCut, type ClusterCutOptions, type ClusterView, createClusterCutter } from "./cluster-cut";
import { type ClusterTree, clusterMembers } from "./cluster-tree";
import type {
	GraphraumCameraState,
	GraphraumData,
	GraphraumEdge,
	GraphraumEdgeVisual,
	GraphraumNode,
	GraphraumNodeVisual,
} from "./types";

export type { ClusterCut, ClusterCutOptions, ClusterView } from "./cluster-cut";
export { createClusterCutter, createProjector } from "./cluster-cut";
export type { ClusterTree, ClusterTreeInput } from "./cluster-tree";
export { buildClusterTree, clusterMembers, clusterTreeTransferables } from "./cluster-tree";

/** The part of `Graphraum` that cluster LOD drives. */
export interface ClusterLodGraph {
	getCameraState(): GraphraumCameraState;
	onViewChange(listener: () => void): () => void;
	setData(data: GraphraumData, options?: { fit?: boolean }): void;
}

/** What a host knows about one aggregate glyph, to style it. */
export interface ClusterGlyphInfo {
	centroid: { x: number; y: number; z: number };
	count: number;
	depth: number;
	/** Radius of the sphere around the members. */
	radius: number;
}

export interface ClusterLodOptions extends ClusterCutOptions {
	/** Style of an aggregate edge from its weight relative to the heaviest drawn one (0..1). */
	aggregateEdgeStyle?: (weight: number, relativeWeight: number) => GraphraumEdgeVisual;
	/** Style of an aggregate glyph. The default sizes it by member count and leaves the colour to the theme. */
	aggregateStyle?: (info: ClusterGlyphInfo) => GraphraumNodeVisual;
	/** The data the tree was built from: node `i` has the position `i` of the tree, edge `k` is the pair `k`. */
	data: GraphraumData;
	/** The element the graph is mounted in; its size gives the pixel scale. */
	element: HTMLElement;
	/** Fit the camera to the first cut (default true). */
	fit?: boolean;
	/** Prefix of aggregate ids, so they cannot collide with yours. Default `cluster:`. */
	idPrefix?: string;
	/** Called after every cut that was drawn. */
	onCut?: (diagnostics: ClusterLodDiagnostics) => void;
}

export interface ClusterLodDiagnostics {
	/** Aggregate glyphs drawn. */
	drawnAggregates: number;
	/** Aggregate and real edges drawn. */
	drawnEdges: number;
	/** Real nodes drawn as themselves. */
	drawnNodes: number;
	/** Edge candidates the budget left out. */
	droppedEdges: number;
	/** Deepest tree level in the cut. */
	cutDepth: number;
	/** Milliseconds the last cut and its data took on the main thread. */
	cutMilliseconds: number;
}

/** What an id drawn by cluster LOD stands for. */
export type ClusterLodHit = { cluster: number; count: number; kind: "cluster" } | { kind: "node"; node: number };

export interface ClusterLodHandle {
	/** Stops following the camera. The last cut stays drawn. */
	detach(): void;
	getDiagnostics(): ClusterLodDiagnostics;
	/** The camera pose that frames a cluster, for `setCameraState`. */
	frameCluster(cluster: number): GraphraumCameraState;
	/** Node indices of a cluster. */
	members(cluster: number): Uint32Array;
	/** Maps an id from `pick` or `pickHit` to a cluster or a real node, or null for an id this layer did not draw. */
	resolve(id: string): ClusterLodHit | null;
	/** Cuts again for the current camera, for example after the canvas changed size. */
	refresh(): void;
}

const DEFAULT_PREFIX = "cluster:";
const FIT_FILL = 2.4;

function defaultNodeRadius(data: GraphraumData): number {
	const sizes = data.nodes.slice(0, 256).map((node) => node.size ?? node.width ?? 4);
	return sizes.reduce((sum, size) => sum + size, 0) / Math.max(sizes.length, 1);
}

function viewOf(state: GraphraumCameraState, element: HTMLElement): ClusterView {
	const size = { height: Math.max(element.clientHeight, 1), width: Math.max(element.clientWidth, 1) };
	return state.mode === "2d"
		? { ...size, center: state.center, mode: "2d", visibleHeight: state.visibleHeight }
		: { ...size, mode: "3d", position: state.position, target: state.target };
}

function viewKey(view: ClusterView): string {
	return view.mode === "2d"
		? [view.width, view.height, view.center.x, view.center.y, view.visibleHeight].join(",")
		: [view.width, view.height, ...Object.values(view.position), ...Object.values(view.target)].join(",");
}

/** A cheap fingerprint of which clusters and nodes a cut draws. Edges follow from them. */
function cutKey(cut: ClusterCut): string {
	let hash = 2166136261;
	for (const list of [cut.clusters, cut.nodes]) {
		for (const value of list) hash = Math.imul(hash ^ value, 16777619);
		hash = Math.imul(hash ^ 0x9e3779b9, 16777619);
	}
	return `${cut.clusters.length}:${cut.nodes.length}:${cut.edgeSource.length}:${hash >>> 0}`;
}

/**
 * Draws the graph as a cut of a cluster tree: clusters too small on screen to matter become one glyph
 * sized by member count, joined by aggregated edges, and the rest stays real nodes. Each camera
 * change makes a new cut and hands it to `graph.setData()`, so the work per frame is bounded by the
 * budgets, not by the graph. Do not call `setData` yourself while attached.
 */
export function attachClusterLod(
	graph: ClusterLodGraph,
	tree: ClusterTree,
	options: ClusterLodOptions,
): ClusterLodHandle {
	const { data, element } = options;
	if (data.nodes.length !== tree.nodeCount) {
		throw new Error("Cluster LOD data must have the nodes the tree was built from, in the same order.");
	}
	const prefix = options.idPrefix ?? DEFAULT_PREFIX;
	const cutter = createClusterCutter(tree);
	const nodeRadius = defaultNodeRadius(data);
	const dims = tree.dimensions;
	const centroidOf = (cluster: number) => ({
		x: tree.centroid[cluster * dims] as number,
		y: tree.centroid[cluster * dims + 1] as number,
		z: dims === 3 ? (tree.centroid[cluster * dims + 2] as number) : 0,
	});
	const glyph = (cluster: number): GraphraumNodeVisual => {
		const info: ClusterGlyphInfo = {
			centroid: centroidOf(cluster),
			count: tree.memberCount[cluster] as number,
			depth: tree.depth[cluster] as number,
			radius: tree.radius[cluster] as number,
		};
		if (options.aggregateStyle) return options.aggregateStyle(info);
		const area = nodeRadius * Math.sqrt(info.count) * 0.7;
		return { size: Math.max(nodeRadius * 1.5, Math.min(area, Math.max(info.radius, nodeRadius))) };
	};
	const edgeStyle = (weight: number, relative: number): GraphraumEdgeVisual =>
		options.aggregateEdgeStyle?.(weight, relative) ?? {
			opacity: 0.2 + 0.6 * Math.sqrt(relative),
			width: 0.6 + 2.4 * Math.sqrt(relative),
		};

	let diagnostics: ClusterLodDiagnostics = {
		cutDepth: 0,
		cutMilliseconds: 0,
		drawnAggregates: 0,
		drawnEdges: 0,
		drawnNodes: 0,
		droppedEdges: 0,
	};
	let lastViewKey = "";
	let lastCutKey = "";
	let drawing = false;
	let detached = false;

	function draw(cut: ClusterCut, fit: boolean, cutMilliseconds: number) {
		const elementIds = [
			...Array.from(cut.clusters, (cluster) => `${prefix}${cluster}`),
			...Array.from(cut.nodes, (node) => (data.nodes[node] as GraphraumNode).id),
		];
		const nodes: GraphraumNode[] = [
			...Array.from(
				cut.clusters,
				(cluster, position): GraphraumNode => ({
					id: elementIds[position] as string,
					position: centroidOf(cluster),
					...glyph(cluster),
				}),
			),
			...Array.from(cut.nodes, (node) => data.nodes[node] as GraphraumNode),
		];
		let heaviest = 0;
		for (let edge = 0; edge < cut.edgeWeight.length; edge += 1) {
			if ((cut.edgeIndex[edge] as number) < 0) heaviest = Math.max(heaviest, cut.edgeWeight[edge] as number);
		}
		const edges: GraphraumEdge[] = Array.from(cut.edgeWeight, (weight, edge): GraphraumEdge => {
			const realIndex = cut.edgeIndex[edge] as number;
			if (realIndex >= 0) return data.edges[realIndex] as GraphraumEdge;
			const source = elementIds[cut.edgeSource[edge] as number] as string;
			const target = elementIds[cut.edgeTarget[edge] as number] as string;
			return { id: `${prefix}edge:${source}>${target}`, source, target, ...edgeStyle(weight, weight / heaviest) };
		});
		const startedAt = performance.now();
		drawing = true;
		try {
			graph.setData({ edges, nodes }, { fit });
		} finally {
			drawing = false;
		}
		diagnostics = {
			cutDepth: cut.cutDepth,
			cutMilliseconds: cutMilliseconds + performance.now() - startedAt,
			drawnAggregates: cut.clusters.length,
			drawnEdges: cut.edgeWeight.length,
			drawnNodes: cut.nodes.length,
			droppedEdges: cut.edgeCandidates - cut.edgeWeight.length,
		};
		options.onCut?.(diagnostics);
	}

	function update(force: boolean, fit = false) {
		if (detached || drawing) return;
		const view = viewOf(graph.getCameraState(), element);
		const key = viewKey(view);
		if (!force && key === lastViewKey) return;
		lastViewKey = key;
		const startedAt = performance.now();
		const cut = cutter(view, options);
		const signature = cutKey(cut);
		if (!force && signature === lastCutKey) return;
		lastCutKey = signature;
		draw(cut, fit, performance.now() - startedAt);
	}

	// The first cut has no real camera to follow: cut as if the whole tree were in view.
	const firstView = viewOf(graph.getCameraState(), element);
	const spread = (tree.radius[0] as number) * 2.2 || 1;
	const wholeTree: ClusterView =
		firstView.mode === "2d"
			? {
					...firstView,
					center: centroidOf(0),
					visibleHeight: Math.max(spread, spread / (firstView.width / firstView.height)),
				}
			: {
					...firstView,
					position: { ...centroidOf(0), z: centroidOf(0).z + spread * FIT_FILL },
					target: centroidOf(0),
				};
	if (options.fit !== false) {
		const startedAt = performance.now();
		const cut = cutter(wholeTree, options);
		lastCutKey = cutKey(cut);
		draw(cut, true, performance.now() - startedAt);
	}
	const unsubscribe = graph.onViewChange(() => update(false));

	return {
		detach() {
			detached = true;
			unsubscribe();
		},
		frameCluster(cluster) {
			const center = centroidOf(cluster);
			const radius = Math.max(tree.radius[cluster] as number, nodeRadius);
			const state = graph.getCameraState();
			if (state.mode === "2d") return { center: { x: center.x, y: center.y }, mode: "2d", visibleHeight: radius * 2.4 };
			const away =
				Math.hypot(
					state.position.x - state.target.x,
					state.position.y - state.target.y,
					state.position.z - state.target.z,
				) || 1;
			const distance = radius * FIT_FILL * 1.2;
			const scale = distance / away;
			return {
				mode: "3d",
				position: {
					x: center.x + (state.position.x - state.target.x) * scale,
					y: center.y + (state.position.y - state.target.y) * scale,
					z: center.z + (state.position.z - state.target.z) * scale,
				},
				target: center,
			};
		},
		getDiagnostics: () => diagnostics,
		members: (cluster) => clusterMembers(tree, cluster),
		refresh: () => update(true),
		resolve(id) {
			if (id.startsWith(prefix) && !id.startsWith(`${prefix}edge:`)) {
				const cluster = Number(id.slice(prefix.length));
				return Number.isInteger(cluster) && cluster >= 0 && cluster < tree.clusterCount
					? { cluster, count: tree.memberCount[cluster] as number, kind: "cluster" }
					: null;
			}
			const node = data.nodes.findIndex((candidate) => candidate.id === id);
			return node < 0 ? null : { kind: "node", node };
		},
	};
}
