import { type ClusterCut, type ClusterCutOptions, type ClusterView, createClusterCutter } from "./cluster-cut";
import { type ClusterTree, clusterMembers } from "./cluster-tree";
import { interpolateCamera } from "./lod-camera";
import { clusterFill } from "./lod-format";
import { createLabelLayer, type LabelPosition } from "./lod-labels";
import { type ClusterLodSource, DEFAULT_NODE_SIZE, lodSourceOf, sampleNodeRadius } from "./lod-source";
import { type DrawnSet, diffDrawn } from "./lod-swap";
import {
	type CutElements,
	clusterKey,
	MINIMUM_SCALE,
	nodeKey,
	planIsEmpty,
	planTransition,
	sampleTransition,
	type TransitionPlan,
	type Vec3,
} from "./lod-transition";
import {
	DEFAULT_UPDATE_MS,
	drawnElementOf,
	type MorphTrack,
	sampleMorph,
	trackIsStill,
	voteDrawnElement,
} from "./lod-update";
import type {
	GraphraumCameraState,
	GraphraumData,
	GraphraumDataPatch,
	GraphraumEdge,
	GraphraumEdgeVisual,
	GraphraumNode,
	GraphraumNodeUpdate,
	GraphraumNodeVisual,
} from "./types";

/** The part of `Graphraum` that cluster LOD drives. */
export interface ClusterLodGraph {
	applyDataPatch(patch: GraphraumDataPatch): void;
	getCameraState(): GraphraumCameraState;
	getNodeScreenPosition(nodeId: string): LabelPosition | null;
	onViewChange(listener: () => void): () => void;
	pick(clientX: number, clientY: number): string | null;
	setCameraState(state: GraphraumCameraState): void;
	setData(data: GraphraumData, options?: { fit?: boolean }): void;
	updateNodes(updates: readonly GraphraumNodeUpdate[]): void;
}

/** What a host knows about one aggregate glyph, to style it. */
export interface ClusterGlyphInfo {
	centroid: { x: number; y: number; z: number };
	cluster: number;
	count: number;
	depth: number;
	/** Radius of the sphere around the members. */
	radius: number;
}

export interface ClusterLodOptions extends ClusterCutOptions {
	/** Style of an aggregate edge from its weight and a 0..1 strength that grows with the logarithm of the weight. */
	aggregateEdgeStyle?: (weight: number, strength: number) => GraphraumEdgeVisual;
	/** Style of an aggregate glyph. The default sizes it by member count and colours it from the tree's colour summary. */
	aggregateStyle?: (info: ClusterGlyphInfo) => GraphraumNodeVisual;
	/** Click an aggregate to zoom in on it (default true). */
	clickToZoom?: boolean;
	/** The data the tree was built from: node `i` has the position `i` of the tree, edge `k` is the pair `k`. Give this or `source`. */
	data?: GraphraumData;
	/** The element the graph is mounted in; its size gives the pixel scale. */
	element: HTMLElement;
	/** Fit the camera to the first cut (default true). With false the camera stays where it is. */
	fit?: boolean;
	/** Prefix of aggregate ids, so they cannot collide with yours. Default `cluster:`. */
	idPrefix?: string;
	/** Count labels on aggregates (default true). */
	labels?: boolean;
	/** Called when an aggregate is clicked, before the zoom. */
	onClusterClick?: (cluster: number, count: number) => void;
	/** Called after every cut that was drawn. */
	onCut?: (diagnostics: ClusterLodDiagnostics) => void;
	/** Builds the real nodes and edges of a cut on demand, for graphs you do not hold as objects. Give this or `data`. */
	source?: ClusterLodSource;
	/** Whether to skip animation. Default: the `prefers-reduced-motion` setting, read at every change. */
	prefersReducedMotion?: () => boolean;
	/** Runs `callback` on the next frame and returns a function that cancels it. Default `requestAnimationFrame`. */
	schedule?: (callback: (nowMilliseconds: number) => void) => () => void;
	/** Length of the split and merge animation in milliseconds; 0 swaps at once. Default 200. */
	transitionMilliseconds?: number;
	/** Time `update` takes to move the drawn elements from the old tree to the new one, in milliseconds. Default 600; 0 swaps at once. */
	updateMilliseconds?: number;
	/** Length of the zoom after a click in milliseconds. Default 450. */
	zoomMilliseconds?: number;
}

export interface ClusterLodDiagnostics {
	/** Deepest tree level in the cut. */
	cutDepth: number;
	/** Milliseconds the last cut and its data swap took on the main thread. */
	cutMilliseconds: number;
	/** Aggregate glyphs drawn. */
	drawnAggregates: number;
	/** Aggregate and real edges drawn. */
	drawnEdges: number;
	/** Real nodes drawn as themselves. */
	drawnNodes: number;
	/** Edge candidates the budget left out. */
	droppedEdges: number;
	/** True while a split or merge animation runs. */
	transitioning: boolean;
}

/** What an id drawn by cluster LOD stands for. */
export type ClusterLodHit = { cluster: number; count: number; kind: "cluster" } | { kind: "node"; node: number };

export interface ClusterLodHandle {
	/** Stops following the camera and removes the labels and click handler. The last cut stays drawn. */
	detach(): void;
	/** The camera pose that frames a cluster, for `setCameraState`. */
	frameCluster(cluster: number): GraphraumCameraState;
	getDiagnostics(): ClusterLodDiagnostics;
	/** Node indices of a cluster. */
	members(cluster: number): Uint32Array;
	/** Cuts again for the current camera, for example after the canvas changed size. */
	refresh(): void;
	/** Maps an id from `pick` or `pickHit` to a cluster or a real node, or null for an id this layer did not draw. */
	resolve(id: string): ClusterLodHit | null;
	/**
	 * Moves the layer to a tree built from a grown graph, keeping the camera. The new data must start
	 * with the nodes of the old, in the same order (a stream appends). Every glyph and node glides from
	 * what it grew out of to its new place and size, new ones grow in and dropped ones shrink away, so
	 * a stream reads as one graph growing rather than a new picture per batch.
	 */
	update(tree: ClusterTree, data: { data?: GraphraumData; source?: ClusterLodSource }): void;
	/** Moves the camera to frame a cluster, animated unless reduced motion is on. Resolves false when something else moved the camera first. */
	zoomToCluster(cluster: number): Promise<boolean>;
}

const DEFAULT_PREFIX = "cluster:";
const FIT_FILL = 2.4;
const DEFAULT_TRANSITION_MS = 200;
const DEFAULT_ZOOM_MS = 450;
/** A cut change that moves more elements than this swaps at once. */
const MAXIMUM_ANIMATED = 800;
/** A pointer that moved more than this many pixels between press and release dragged; it did not click. */
const CLICK_SLOP_PIXELS = 5;

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

/** Whether the system asks for less motion. Absent `matchMedia` (tests, workers) means no preference. */
function systemPrefersReducedMotion() {
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function defaultSchedule(callback: (nowMilliseconds: number) => void) {
	const handle = requestAnimationFrame(callback);
	return () => cancelAnimationFrame(handle);
}

interface ActiveMorph {
	cancel: () => void;
	/** What the graph holds once the morph is done. */
	next: DrawnSet;
	/** Resting node of every tracked id: where a staying element ends, or the leaving one as it was. */
	rest: Map<string, GraphraumNode>;
	tracks: MorphTrack[];
}

interface ActiveTransition {
	cancel: () => void;
	/** Final node of every animated key, entering and growing ones at their resting place. */
	final: Map<string, GraphraumNode>;
	plan: TransitionPlan;
	startedAt: number | null;
}

/**
 * Draws the graph as a cut of a cluster tree: clusters too small on screen to matter become one glyph
 * sized by member count and coloured from their members, joined by aggregated edges, and the rest stays
 * real nodes. Each camera change makes a new cut and applies only the nodes and edges that arrived or
 * left, with a short split or merge animation. Do not call `setData` yourself while attached.
 */
export function attachClusterLod(
	graph: ClusterLodGraph,
	initialTree: ClusterTree,
	options: ClusterLodOptions,
): ClusterLodHandle {
	let tree = initialTree;
	const { element } = options;
	let store = lodSourceOf(options);
	if (store.nodeCount !== tree.nodeCount) {
		throw new Error("Cluster LOD data must have the nodes the tree was built from, in the same order.");
	}
	const prefix = options.idPrefix ?? DEFAULT_PREFIX;
	const schedule = options.schedule ?? defaultSchedule;
	const reducedMotion = options.prefersReducedMotion ?? systemPrefersReducedMotion;
	const transitionMs = options.transitionMilliseconds ?? DEFAULT_TRANSITION_MS;
	const zoomMs = options.zoomMilliseconds ?? DEFAULT_ZOOM_MS;
	let cutter = createClusterCutter(tree);
	const nodeRadius = sampleNodeRadius(store);
	// Ids of the real nodes asked for lately, so `resolve` finds an id the layer drew without a lookup over all nodes.
	const indexById = new Map<string, number>();
	const dims = tree.dimensions;
	const centroidOf = (cluster: number): Vec3 => ({
		x: tree.centroid[cluster * dims] as number,
		y: tree.centroid[cluster * dims + 1] as number,
		z: dims === 3 ? (tree.centroid[cluster * dims + 2] as number) : 0,
	});

	const glyph = (cluster: number): GraphraumNodeVisual => {
		const info: ClusterGlyphInfo = {
			centroid: centroidOf(cluster),
			cluster,
			count: tree.memberCount[cluster] as number,
			depth: tree.depth[cluster] as number,
			radius: tree.radius[cluster] as number,
		};
		if (options.aggregateStyle) return options.aggregateStyle(info);
		const size = nodeRadius * (1.6 + 0.9 * Math.sqrt(info.count));
		return { ...clusterFill(tree, cluster), size: Math.min(size, Math.max(info.radius * 1.1, nodeRadius * 2.5)) };
	};
	const edgeStyle = (weight: number): GraphraumEdgeVisual => {
		const strength = Math.min(Math.log10(1 + weight) / 4, 1);
		return (
			options.aggregateEdgeStyle?.(weight, strength) ?? { opacity: 0.18 + 0.6 * strength, width: 0.6 + 2.4 * strength }
		);
	};

	const clusterNode = (cluster: number): GraphraumNode => ({
		id: `${prefix}${cluster}`,
		position: centroidOf(cluster),
		...glyph(cluster),
	});
	const elementNode = (key: string): GraphraumNode => {
		if (key.startsWith("c")) return clusterNode(Number(key.slice(1)));
		const index = Number(key.slice(1));
		const node = store.node(index);
		indexById.set(node.id, index);
		return node;
	};

	const snapshotOf = (cut: ClusterCut): DrawnSet => {
		const keys = [...Array.from(cut.clusters, clusterKey), ...Array.from(cut.nodes, nodeKey)];
		const nodes = new Map<string, GraphraumNode>();
		const ids: string[] = [];
		for (const key of keys) {
			const node = elementNode(key);
			nodes.set(node.id, node);
			ids.push(node.id);
		}
		const edges = new Map<string, GraphraumEdge>();
		for (let edge = 0; edge < cut.edgeWeight.length; edge += 1) {
			const realIndex = cut.edgeIndex[edge] as number;
			if (realIndex >= 0) {
				const real = store.edge(realIndex);
				edges.set(real.id, real);
				continue;
			}
			const source = ids[cut.edgeSource[edge] as number] as string;
			const target = ids[cut.edgeTarget[edge] as number] as string;
			const id = `${prefix}edge:${source}>${target}`;
			edges.set(id, { id, source, target, ...edgeStyle(cut.edgeWeight[edge] as number) });
		}
		return { edges, nodes };
	};

	let diagnostics: ClusterLodDiagnostics = {
		cutDepth: 0,
		cutMilliseconds: 0,
		drawnAggregates: 0,
		drawnEdges: 0,
		drawnNodes: 0,
		droppedEdges: 0,
		transitioning: false,
	};
	let lastViewKey = "";
	let lastCutKey = "";
	let drawn: DrawnSet = { edges: new Map(), nodes: new Map() };
	let committed: CutElements = { clusters: new Set(), nodes: new Set() };
	let transition: ActiveTransition | null = null;
	let morph: ActiveMorph | null = null;
	let pending = false;
	let detached = false;
	let applying = false;
	let cancelZoom: (() => void) | null = null;

	const labels =
		options.labels !== false && typeof document !== "undefined"
			? createLabelLayer(element, (id) => graph.getNodeScreenPosition(id))
			: null;
	const aggregateItems = () =>
		[...drawn.nodes.keys()]
			.filter((id) => id.startsWith(prefix))
			.map((id) => ({ count: tree.memberCount[Number(id.slice(prefix.length))] ?? 0, id }))
			.filter((item) => item.count > 0);

	function recordCut(cut: ClusterCut, startedAt: number) {
		diagnostics = {
			cutDepth: cut.cutDepth,
			cutMilliseconds: performance.now() - startedAt,
			drawnAggregates: cut.clusters.length,
			drawnEdges: cut.edgeWeight.length,
			drawnNodes: cut.nodes.length,
			droppedEdges: cut.edgeCandidates - cut.edgeWeight.length,
			transitioning: transition !== null,
		};
		labels?.setItems(aggregateItems());
		labels?.update();
		options.onCut?.(diagnostics);
	}

	/** Moves the graph from what it holds to `next` through one patch. */
	function swap(next: DrawnSet) {
		applying = true;
		try {
			graph.applyDataPatch(diffDrawn(drawn, next));
		} finally {
			applying = false;
		}
		drawn = next;
		if (indexById.size > 2 * next.nodes.size + 2048) {
			for (const id of indexById.keys()) if (!next.nodes.has(id)) indexById.delete(id);
		}
	}

	/** The size fields of `node` times `scale`, only the ones it has: a missing key means the default size. */
	const scaledSize = (node: GraphraumNode, scale: number) => {
		const bare = node.size === undefined && node.width === undefined && node.height === undefined;
		return {
			...(bare ? { size: DEFAULT_NODE_SIZE * scale } : {}),
			...(node.size === undefined ? {} : { size: node.size * scale }),
			...(node.width === undefined ? {} : { width: node.width * scale }),
			...(node.height === undefined ? {} : { height: node.height * scale }),
		};
	};
	const nodeUpdate = (node: GraphraumNode, position: Vec3, scale: number): GraphraumNodeUpdate => ({
		id: node.id,
		position,
		...scaledSize(node, scale),
	});

	/**
	 * Moves nodes in the graph and notes where they now are in `drawn`, so the next swap compares with what is
	 * really on screen, not with where an animation was headed.
	 */
	function place(placements: readonly { node: GraphraumNode; position: Vec3; scale: number }[]) {
		if (placements.length === 0) return;
		graph.updateNodes(placements.map(({ node, position, scale }) => nodeUpdate(node, position, scale)));
		for (const { node, position, scale } of placements) {
			drawn.nodes.set(node.id, { ...node, position, ...scaledSize(node, scale) });
		}
	}

	function finishTransition(active: ActiveTransition) {
		active.cancel();
		transition = null;
		place(
			[...active.plan.entering.map(({ key }) => key), ...active.plan.growing].map((key) => restPlacement(active, key)),
		);
		const rest = new Map(drawn.nodes);
		for (const { key } of active.plan.leaving) rest.delete(elementNode(key).id);
		for (const [key, node] of active.final)
			if (rest.has(node.id) && !active.plan.leaving.some((l) => l.key === key)) rest.set(node.id, node);
		const edges = new Map(drawn.edges);
		for (const [id, edge] of drawn.edges) if (!rest.has(edge.source) || !rest.has(edge.target)) edges.delete(id);
		swap({ edges, nodes: rest });
		labels?.setItems(aggregateItems());
		labels?.update();
		diagnostics = { ...diagnostics, transitioning: false };
		if (pending) {
			pending = false;
			update(true);
		}
	}

	const restPlacement = (active: ActiveTransition, key: string) => {
		const node = active.final.get(key) as GraphraumNode;
		return { node, position: { x: node.position.x, y: node.position.y, z: node.position.z ?? 0 }, scale: 1 };
	};

	function startTransition(plan: TransitionPlan, final: Map<string, GraphraumNode>) {
		const active: ActiveTransition = { cancel: () => undefined, final, plan, startedAt: null };
		transition = active;
		const finalPosition = (key: string): Vec3 => {
			const node = final.get(key) as GraphraumNode;
			return { x: node.position.x, y: node.position.y, z: node.position.z ?? 0 };
		};
		const tick = (now: number) => {
			if (detached || transition !== active) return;
			active.startedAt ??= now;
			const progress = (now - active.startedAt) / transitionMs;
			if (progress >= 1) {
				finishTransition(active);
				return;
			}
			place(
				sampleTransition(plan, progress, finalPosition).map(({ key, position, scale }) => ({
					node: final.get(key) as GraphraumNode,
					position,
					scale,
				})),
			);
			labels?.update();
			active.cancel = schedule(tick);
		};
		active.cancel = schedule(tick);
	}

	function apply(cut: ClusterCut, startedAt: number) {
		const next = snapshotOf(cut);
		const after: CutElements = { clusters: new Set(cut.clusters), nodes: new Set(cut.nodes) };
		const animate = transitionMs > 0 && !reducedMotion();
		const plan = animate ? planTransition(tree, committed, after, centroidOf) : null;
		committed = after;
		if (!plan || planIsEmpty(plan) || plan.entering.length + plan.leaving.length > MAXIMUM_ANIMATED) {
			swap(next);
			recordCut(cut, startedAt);
			return;
		}
		// Entering and growing glyphs start small and, when they split off, at their parent; the old ones stay until they shrink away.
		const final = new Map<string, GraphraumNode>();
		const start = new Map(next.nodes);
		for (const { from, key } of plan.entering) {
			const node = elementNode(key);
			final.set(key, node);
			start.set(node.id, { ...node, ...scaledSize(node, MINIMUM_SCALE), position: from });
		}
		for (const key of plan.growing) {
			const node = elementNode(key);
			final.set(key, node);
			start.set(node.id, { ...node, ...scaledSize(node, MINIMUM_SCALE) });
		}
		const startEdges = new Map(next.edges);
		for (const { key } of plan.leaving) {
			const node = drawn.nodes.get(elementNode(key).id);
			if (!node) continue;
			final.set(key, node);
			start.set(node.id, node);
		}
		swap({ edges: startEdges, nodes: start });
		startTransition(plan, final);
		recordCut(cut, startedAt);
	}

	function update(force: boolean) {
		if (detached || applying) return;
		if (transition || morph) {
			pending = true;
			return;
		}
		const view = viewOf(graph.getCameraState(), element);
		const key = viewKey(view);
		if (!force && key === lastViewKey) return;
		lastViewKey = key;
		const startedAt = performance.now();
		const cut = cutter(view, options);
		const signature = cutKey(cut);
		if (!force && signature === lastCutKey) return;
		lastCutKey = signature;
		apply(cut, startedAt);
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
			: { ...firstView, position: { ...centroidOf(0), z: centroidOf(0).z + spread * FIT_FILL }, target: centroidOf(0) };
	{
		const startedAt = performance.now();
		const cut = cutter(wholeTree, options);
		lastCutKey = cutKey(cut);
		const first = snapshotOf(cut);
		committed = { clusters: new Set(cut.clusters), nodes: new Set(cut.nodes) };
		applying = true;
		try {
			graph.setData(
				{ edges: [...first.edges.values()], nodes: [...first.nodes.values()] },
				{ fit: options.fit !== false },
			);
		} finally {
			applying = false;
		}
		drawn = first;
		recordCut(cut, startedAt);
	}
	const unsubscribe = graph.onViewChange(() => {
		update(false);
		if (!transition) labels?.update();
	});

	const sizeOf = (node: GraphraumNode) => node.size ?? DEFAULT_NODE_SIZE;

	function finishMorph(active: ActiveMorph) {
		active.cancel();
		morph = null;
		place(
			active.tracks
				.filter((track) => track.toScale === 1)
				.map((track) => ({ node: active.rest.get(track.id) as GraphraumNode, position: track.to, scale: 1 })),
		);
		swap(active.next);
		labels?.setItems(aggregateItems());
		labels?.update();
		diagnostics = { ...diagnostics, transitioning: false };
		if (pending) {
			pending = false;
			update(true);
		}
	}

	function updateTree(nextTree: ClusterTree, data: { data?: GraphraumData; source?: ClusterLodSource }) {
		if (detached) return;
		const nextStore = lodSourceOf(data);
		if (nextStore.nodeCount !== nextTree.nodeCount) {
			throw new Error("Cluster LOD data must have the nodes the tree was built from, in the same order.");
		}
		if (nextTree.dimensions !== dims) throw new Error("Cluster LOD update must keep the tree's dimensions.");
		if (nextTree.nodeCount < tree.nodeCount)
			throw new Error("Cluster LOD update must keep every node of the old tree.");
		pending = false;
		if (transition) finishTransition(transition);
		// What the graph shows now, by id, with the place and size a running animation gave each node.
		const shown = drawn.nodes;
		if (morph) {
			morph.cancel();
			morph = null;
		}
		const oldTree = tree;
		const oldCommitted = committed;
		const oldStore = store;
		const oldIdOf = (key: string) =>
			key.startsWith("c") ? `${prefix}${key.slice(1)}` : oldStore.node(Number(key.slice(1))).id;

		tree = nextTree;
		store = nextStore;
		cutter = createClusterCutter(tree);
		indexById.clear();
		const view = viewOf(graph.getCameraState(), element);
		const startedAt = performance.now();
		const cut = cutter(view, options);
		lastViewKey = viewKey(view);
		lastCutKey = cutKey(cut);
		const next = snapshotOf(cut);
		committed = { clusters: new Set(cut.clusters), nodes: new Set(cut.nodes) };
		const durationMs = options.updateMilliseconds ?? DEFAULT_UPDATE_MS;
		if (durationMs <= 0 || reducedMotion()) {
			swap(next);
			recordCut(cut, startedAt);
			return;
		}

		const elementOf = (index: number) => drawnElementOf(oldTree, oldCommitted, index);
		const tracks: MorphTrack[] = [];
		const start = new Map(next.nodes);
		const rest = new Map<string, GraphraumNode>();
		const used = new Set<string>();
		const follow = (id: string, fromKey: string | null) => {
			const node = next.nodes.get(id) as GraphraumNode;
			rest.set(id, node);
			const fromId = fromKey === null ? null : oldIdOf(fromKey);
			const from = fromId === null ? undefined : shown.get(fromId);
			const to = { x: node.position.x, y: node.position.y, z: node.position.z ?? 0 };
			if (fromId !== null && from) used.add(fromId);
			const track: MorphTrack = from
				? {
						id,
						from: { x: from.position.x, y: from.position.y, z: from.position.z ?? 0 },
						fromScale: sizeOf(from) / sizeOf(node),
						to,
						toScale: 1,
					}
				: { id, from: to, fromScale: MINIMUM_SCALE, to, toScale: 1 };
			if (trackIsStill(track)) return;
			tracks.push(track);
			start.set(id, { ...node, position: track.from, ...scaledSize(node, track.fromScale) });
		};
		for (const cluster of cut.clusters) {
			follow(`${prefix}${cluster}`, voteDrawnElement(clusterMembers(tree, cluster), elementOf));
		}
		for (const index of cut.nodes) follow(store.node(index).id, elementOf(index));
		for (const [id, node] of shown) {
			if (next.nodes.has(id) || used.has(id)) continue;
			const at = { x: node.position.x, y: node.position.y, z: node.position.z ?? 0 };
			rest.set(id, node);
			start.set(id, node);
			tracks.push({ id, from: at, fromScale: 1, to: at, toScale: MINIMUM_SCALE });
		}
		swap({ edges: next.edges, nodes: start });
		recordCut(cut, startedAt);
		if (tracks.length === 0) return;
		const active: ActiveMorph = { cancel: () => undefined, next, rest, tracks };
		morph = active;
		diagnostics = { ...diagnostics, transitioning: true };
		let begun: number | null = null;
		const tick = (now: number) => {
			if (detached || morph !== active) return;
			begun ??= now;
			const progress = (now - begun) / durationMs;
			if (progress >= 1) {
				finishMorph(active);
				return;
			}
			place(
				tracks.map((track) => {
					const { position, scale } = sampleMorph(track, progress);
					return { node: rest.get(track.id) as GraphraumNode, position, scale };
				}),
			);
			labels?.update();
			active.cancel = schedule(tick);
		};
		active.cancel = schedule(tick);
	}

	function frameCluster(cluster: number): GraphraumCameraState {
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
		const scale = (radius * FIT_FILL * 1.2) / away;
		return {
			mode: "3d",
			position: {
				x: center.x + (state.position.x - state.target.x) * scale,
				y: center.y + (state.position.y - state.target.y) * scale,
				z: center.z + (state.position.z - state.target.z) * scale,
			},
			target: center,
		};
	}

	function zoomToCluster(cluster: number): Promise<boolean> {
		cancelZoom?.();
		const to = frameCluster(cluster);
		const from = graph.getCameraState();
		if (zoomMs <= 0 || reducedMotion()) {
			graph.setCameraState(to);
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			let startedAt: number | null = null;
			let cancelFrame = () => {};
			const stop = (arrived: boolean) => {
				cancelFrame();
				if (cancelZoom === cancel) cancelZoom = null;
				resolve(arrived);
			};
			const cancel = () => stop(false);
			cancelZoom = cancel;
			const step = (now: number) => {
				startedAt ??= now;
				const progress = Math.min((now - startedAt) / zoomMs, 1);
				graph.setCameraState(interpolateCamera(from, to, progress));
				if (progress >= 1) stop(true);
				else cancelFrame = schedule(step);
			};
			cancelFrame = schedule(step);
		});
	}

	let pressed: { x: number; y: number } | null = null;
	const onPointerDown = (event: Event) => {
		const { clientX, clientY } = event as PointerEvent;
		pressed = { x: clientX, y: clientY };
	};
	const onClick = (event: Event) => {
		const { clientX, clientY } = event as MouseEvent;
		const moved = pressed ? Math.hypot(clientX - pressed.x, clientY - pressed.y) : 0;
		pressed = null;
		if (detached || moved > CLICK_SLOP_PIXELS) return;
		const id = graph.pick(clientX, clientY);
		const hit = id ? resolve(id) : null;
		if (hit?.kind !== "cluster") return;
		options.onClusterClick?.(hit.cluster, hit.count);
		if (options.clickToZoom !== false) void zoomToCluster(hit.cluster);
	};
	element.addEventListener("pointerdown", onPointerDown);
	element.addEventListener("click", onClick);

	function resolve(id: string): ClusterLodHit | null {
		if (id.startsWith(prefix) && !id.startsWith(`${prefix}edge:`)) {
			const cluster = Number(id.slice(prefix.length));
			return Number.isInteger(cluster) && cluster >= 0 && cluster < tree.clusterCount
				? { cluster, count: tree.memberCount[cluster] as number, kind: "cluster" }
				: null;
		}
		const node = indexById.get(id) ?? store.indexOf?.(id);
		return node === undefined ? null : { kind: "node", node };
	}

	return {
		detach() {
			detached = true;
			transition?.cancel();
			morph?.cancel();
			cancelZoom?.();
			unsubscribe();
			labels?.destroy();
			element.removeEventListener("pointerdown", onPointerDown);
			element.removeEventListener("click", onClick);
		},
		frameCluster,
		getDiagnostics: () => diagnostics,
		members: (cluster) => clusterMembers(tree, cluster),
		refresh: () => update(true),
		resolve,
		update: updateTree,
		zoomToCluster,
	};
}
