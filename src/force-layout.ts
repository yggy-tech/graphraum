/** Per-node target positions that guide a force layout, for example a PCA or UMAP projection of embeddings. */
export interface ForceAnchors {
	/**
	 * `nodeCount * dimensions` values in node order (x, y[, z] per node), in any range: graphraum centres
	 * them and rescales them to the layout's own scale, which grows with `settings.linkDistance`. A node with a NaN value has no anchor.
	 */
	positions: Float32Array;
	/**
	 * Multiplies `settings.anchorStrength`: one finite, non-negative number for all nodes or one per
	 * node. Omitted → 1.
	 */
	strength?: number | Float32Array;
}

/** Input for graphraum's dimension-aware force layout helpers. */
export interface ForceLayoutRequest {
	dimensions: 2 | 3;
	edges: Uint32Array;
	/**
	 * When omitted, `forceIterationCount(nodeCount)` is used, times 8 for `layoutStyle: "edge-t"`.
	 * Explicit values are capped at 64 (`"classic"`) or 512 (`"edge-t"`).
	 */
	iterations?: number;
	/**
	 * Optional rest length per edge (`edges.length / 2` values).
	 * Omitted → `settings.linkDistance` for every edge.
	 */
	linkDistances?: Float32Array;
	nodeCount: number;
	/**
	 * Optional cluster index per node (`nodeCount` values). `createForceSimulation()` seeds nodes
	 * around cluster centres and pulls each node towards its cluster centroid
	 * (`settings.clusterStrength`). A copy is stored; the array is never mutated.
	 */
	clusters?: Uint32Array;
	/**
	 * Optional anchor positions that pull each node towards a target (`settings.anchorStrength`), scaled
	 * by the step alpha. Anchored nodes start at their anchor. Copies are stored.
	 */
	anchors?: ForceAnchors;
	/**
	 * Optional start positions, `nodeCount * 3` values (XYZ per node; Z is ignored in 2D) in layout
	 * units. A node with a NaN value keeps the default start (random, or around its cluster centre).
	 * Infinite values throw. A copy is used. The scale is yours: the layout relaxes from here, so a
	 * start about as large as the relaxed layout (one link distance per hop) works best.
	 * `@yggy-tech/graphraum/layout-start` computes such a start for long chains. `anchors` still seed
	 * the nodes they anchor on top of this, and the cluster pull is unchanged. Nodes added later
	 * with `addNodes()` use the default start.
	 */
	initialPositions?: Float32Array;
	/**
	 * `initialPositions` is a layout that already settled, for example before nodes or edges were added
	 * or removed. A node with a start keeps it (anchors seed only the nodes without one); a node
	 * without one (NaN) keeps the default start, and `placeNewNodes()` from
	 * `@yggy-tech/graphraum/layout-start` puts it next to its neighbours first, which is better.
	 * `computeForcePositions()` then settles from alpha 0.05 in 6 steps instead
	 * of the usual schedule, so known nodes move only a little. A simulation should step with an
	 * alpha of 0.05 or lower. For a removed node, drop its start and remap the indices.
	 */
	warmStart?: boolean;
	settings?: ForceSettings;
	/**
	 * Optional spring strength per edge (`edges.length / 2` values).
	 * Omitted → `settings.springStrength` for every edge.
	 */
	springStrengths?: Float32Array;
}

/**
 * Every supported {@link ForceLayoutStyle}, in documentation order. A new style is added as a new name,
 * so a consumer's choice keeps its meaning across releases.
 */
export const FORCE_LAYOUT_STYLES = ["classic", "edge-t"] as const;

/**
 * A force layout preset: how nodes push each other apart plus the spring, cluster and one-shot
 * schedule that balance that push. The layout guide lists each style's numbers.
 *
 * - `"classic"`: every node is pushed away from 8 sampled nodes with a capped inverse-square force,
 *   whatever its degree. The default.
 * - `"edge-t"`: edge-centric negative sampling with a bounded Student-t force, inspired by SNAP-tFDP
 *   (#191). Each edge end draws `negativeSamples` uniform nodes, so a node's push grows with its degree
 *   and groups separate. Still O(|E| + |V|) per step with no spatial tree.
 */
export type ForceLayoutStyle = (typeof FORCE_LAYOUT_STYLES)[number];

export interface ForceSettings {
	/**
	 * Pull of every anchored node towards its anchor, scaled by the step alpha and the per-node anchor
	 * strength, from `0` to `0.1`. `0.01` is gentle; `0.03` to `0.05` follows the anchors more closely. `0` disables the pull. Ignored without `anchors`.
	 * Omitted → `DEFAULT_FORCE_SETTINGS.anchorStrength`.
	 */
	anchorStrength?: number;
	centerAttraction: number;
	/**
	 * Pull of every node towards its cluster centroid, scaled by the step alpha and the style's
	 * `clusterGain`. `0` disables the pull. Ignored without `clusters`.
	 * Omitted → `DEFAULT_FORCE_SETTINGS.clusterStrength`.
	 */
	clusterStrength?: number;
	damping: number;
	/**
	 * Layout preset. Omitted → `"classic"`. Unknown names throw. The style multiplies
	 * `springStrength`, `clusterStrength` and `repulsion` by its own gains, so the same numbers give
	 * different effective forces in different styles. See {@link ForceLayoutStyle}.
	 */
	layoutStyle?: ForceLayoutStyle;
	linkDistance: number;
	/**
	 * `"edge-t"` only, ignored otherwise: sampled nodes per edge end and step, an integer from 1 to 16.
	 * More samples give a smoother push at a linear cost. Omitted →
	 * `DEFAULT_FORCE_SETTINGS.negativeSamples`.
	 */
	negativeSamples?: number;
	repulsion: number;
	springStrength: number;
	/**
	 * `"edge-t"` only, ignored otherwise: degrees of freedom of the Student-t force, from 0.5 to 10.
	 * Lower values give a heavier tail, so distant groups keep pushing each other apart. Omitted →
	 * `DEFAULT_FORCE_SETTINGS.tDegrees`.
	 */
	tDegrees?: number;
}

export const DEFAULT_FORCE_SETTINGS: Required<ForceSettings> = {
	anchorStrength: 0.01,
	centerAttraction: 0.002,
	clusterStrength: 0.02,
	damping: 0.82,
	layoutStyle: "classic",
	linkDistance: 24,
	negativeSamples: 2,
	repulsion: 400,
	springStrength: 0.005,
	tDegrees: 1,
};

function resolveLayoutStyle(style: ForceLayoutStyle | undefined, fallback: ForceLayoutStyle): ForceLayoutStyle {
	if (style === undefined) return fallback;
	if (!FORCE_LAYOUT_STYLES.includes(style)) {
		throw new Error(`Unknown layoutStyle "${style}"; use one of: ${FORCE_LAYOUT_STYLES.join(", ")}.`);
	}
	return style;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number) {
	const resolved = value === undefined || Number.isNaN(value) ? fallback : value;
	return Math.max(min, Math.min(max, resolved));
}

/**
 * Clamps every field; a missing or NaN value falls back to `base` (the defaults at creation, the
 * current settings in `setSettings()`), so a cleared input field cannot poison the positions.
 */
function normalizeForceSettings(
	settings: Partial<ForceSettings> = DEFAULT_FORCE_SETTINGS,
	base: Required<ForceSettings> = DEFAULT_FORCE_SETTINGS,
): Required<ForceSettings> {
	return {
		anchorStrength: clamp(settings.anchorStrength, base.anchorStrength, 0, 0.1),
		centerAttraction: clamp(settings.centerAttraction, base.centerAttraction, 0, 0.05),
		clusterStrength: clamp(settings.clusterStrength, base.clusterStrength, 0, 0.1),
		damping: clamp(settings.damping, base.damping, 0.1, 0.99),
		layoutStyle: resolveLayoutStyle(settings.layoutStyle, base.layoutStyle),
		linkDistance: clamp(settings.linkDistance, base.linkDistance, 1, 500),
		negativeSamples: Math.round(clamp(settings.negativeSamples, base.negativeSamples, 1, 16)),
		repulsion: clamp(settings.repulsion, base.repulsion, 0, 5_000),
		springStrength: clamp(settings.springStrength, base.springStrength, 0.0001, 0.05),
		tDegrees: clamp(settings.tDegrees, base.tDegrees, 0.5, 10),
	};
}

/** The numbers behind one {@link ForceLayoutStyle}. Internal: the layout guide documents them. */
export interface ForceLayoutStylePreset {
	/** Multiplies `clusterStrength`. */
	readonly clusterGain: number;
	/** Multiplies `forceIterationCount(nodeCount)` for the one-shot default. */
	readonly iterationScale: number;
	/** Cap for an explicit `iterations` request. */
	readonly maxIterations: number;
	/** Push kernel; internal to the style. */
	readonly repulsion: "node-sampled-inverse-square" | "edge-sampled-student-t";
	/** Multiplies `repulsion` / 400 for the Student-t kernel (unused by the classic kernel). */
	readonly repulsionGain: number;
	/** Multiplies `springStrength` and per-edge `springStrengths`. */
	readonly springGain: number;
}

/**
 * Per-style presets, tuned on the deterministic fixtures in `force-layout.quality.test.ts` and checked
 * on held-out fixtures there. `"edge-t"` pushes harder on average than the capped classic force, so
 * it needs stronger springs and a stronger cluster pull, and it keeps separating groups after the
 * classic style has stopped improving, so its one-shot run is longer.
 */
export const FORCE_LAYOUT_STYLE_PRESETS: Readonly<Record<ForceLayoutStyle, ForceLayoutStylePreset>> = {
	classic: {
		clusterGain: 1,
		iterationScale: 1,
		maxIterations: 64,
		repulsion: "node-sampled-inverse-square",
		repulsionGain: 1,
		springGain: 1,
	},
	"edge-t": {
		clusterGain: 2.5,
		iterationScale: 8,
		maxIterations: 512,
		repulsion: "edge-sampled-student-t",
		repulsionGain: 4,
		springGain: 10,
	},
};

/**
 * Most `"edge-t"` draws one node makes per step. With the default 2 samples, nodes up to degree 16 are
 * sampled exactly; above that a node keeps 32 draws whose push is scaled by `wanted draws / 32`, so its
 * expected push still grows with degree. This bounds a step to 32 draws per node (4 times the classic
 * style's 8) however dense the graph or large the hub. On the quality fixtures 32 kept the block-model
 * separation of a 64 cap, 16 lost about a third of it, and 64 cost about 1.5x the dense-graph step time.
 */
const MAX_EDGE_T_DRAWS_PER_NODE = 32;

function normalizePerEdgeArray(
	name: "linkDistances" | "springStrengths",
	values: Float32Array | undefined,
	edgeCount: number,
	min: number,
	max: number,
): Float32Array | null {
	if (values === undefined) return null;
	if (values.length !== edgeCount) {
		throw new Error(`${name} length (${values.length}) must equal edge count (${edgeCount}).`);
	}
	return Float32Array.from(values, (value) => Math.max(min, Math.min(max, value)));
}

export function forceIterationCount(nodeCount: number) {
	return Math.max(8, Math.min(32, Math.ceil(240 / Math.log2(nodeCount + 2))));
}

function resolveForceIterations(nodeCount: number, layoutStyle: ForceLayoutStyle, iterations?: number) {
	const style = FORCE_LAYOUT_STYLE_PRESETS[layoutStyle];
	if (iterations === undefined) return forceIterationCount(nodeCount) * style.iterationScale;
	if (!Number.isSafeInteger(iterations) || iterations < 1) {
		throw new Error("Iterations must be a positive integer.");
	}
	return Math.min(style.maxIterations, iterations);
}

/** Diameter of the default random start at the default link distance; anchors fill half of it. */
function expectedGraphExtent(nodeCount: number) {
	return Math.max(Math.sqrt(nodeCount) * 6, 24);
}

function initialPositions({ dimensions, nodeCount }: Pick<ForceLayoutRequest, "dimensions" | "nodeCount">) {
	const positions = new Float32Array(nodeCount * 3);
	const extent = expectedGraphExtent(nodeCount);
	for (let index = 0; index < nodeCount; index += 1) {
		const offset = index * 3;
		const angle = random(index * 4 + 1) * Math.PI * 2;
		if (dimensions === 2) {
			const radius = Math.sqrt(random(index * 4 + 2)) * extent * 0.5;
			positions.set([Math.cos(angle) * radius, Math.sin(angle) * radius, 0], offset);
			continue;
		}
		const zDirection = random(index * 4 + 2) * 2 - 1;
		const planeRadius = Math.sqrt(1 - zDirection * zDirection);
		const radius = Math.cbrt(random(index * 4 + 3)) * extent * 0.5;
		positions.set(
			[Math.cos(angle) * planeRadius * radius, Math.sin(angle) * planeRadius * radius, zDirection * radius],
			offset,
		);
	}
	return positions;
}

/** Copies the host's start over the default start; a node with any NaN coordinate keeps the default. */
function applyInitialPositions(positions: Float32Array, request: ForceLayoutRequest, start: Float32Array) {
	const { dimensions, nodeCount } = request;
	if (start.length !== nodeCount * 3) {
		throw new Error(`Initial positions (${start.length} values) must be nodeCount * 3 (${nodeCount * 3}).`);
	}
	if (start.some((value) => Math.abs(value) === Infinity)) {
		throw new Error("Initial positions must not contain Infinity.");
	}
	for (let node = 0; node < nodeCount; node += 1) {
		const offset = node * 3;
		if (Number.isNaN(start[offset]) || Number.isNaN(start[offset + 1])) continue;
		if (dimensions === 3 && Number.isNaN(start[offset + 2])) continue;
		positions[offset] = start[offset] ?? 0;
		positions[offset + 1] = start[offset + 1] ?? 0;
		positions[offset + 2] = dimensions === 3 ? (start[offset + 2] ?? 0) : 0;
	}
}

function hash32(seed: number) {
	let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
	value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
	return (value ^ (value >>> 16)) >>> 0;
}

function random(seed: number) {
	return hash32(seed) / 0x1_0000_0000;
}

function assertClusterCount(clusters: Uint32Array, expected: number, subject: string) {
	if (clusters.length !== expected) {
		throw new Error(`Cluster index count (${clusters.length}) must match ${subject} (${expected}).`);
	}
}

/**
 * Live simulations index per-cluster scratch arrays by id, so ids must be dense: below the node count.
 * Validate before allocating anything.
 */
function assertDenseClusterIds(clusters: Uint32Array, totalNodeCount: number) {
	for (const cluster of clusters) {
		if (cluster >= totalNodeCount) {
			throw new Error(
				`Cluster index ${cluster} exceeds the node count ${totalNodeCount}; use dense ids starting at 0.`,
			);
		}
	}
}

function clusterCountOf(clusters: Uint32Array) {
	return clusters.reduce((count, cluster) => Math.max(count, cluster + 1), 0);
}

/**
 * Seeds nodes around cluster centres: centres come from a force layout of the inter-cluster graph
 * and each node is scattered around its centre. Shared by the one-shot and live clustered layouts.
 */
function clusteredInitialPositions(request: ForceLayoutRequest & { clusters: Uint32Array }) {
	const clusterCount = clusterCountOf(request.clusters);
	const clusterSizes = new Uint32Array(clusterCount);
	for (const cluster of request.clusters) clusterSizes[cluster] += 1;
	const discRadius = (cluster: number) => 2 * Math.sqrt(clusterSizes[cluster] ?? 0);
	const clusterEdges = new Uint32Array(request.edges.length);
	// Linked clusters rest one seeded disc radius per side plus 12 units apart, so a small cluster does
	// not get a wider empty margin than a large one (#192).
	const linkDistances = new Float32Array(request.edges.length / 2);
	let edgeCursor = 0;
	for (let index = 0; index < request.edges.length; index += 2) {
		const source = request.clusters[request.edges[index] ?? 0];
		const target = request.clusters[request.edges[index + 1] ?? 0];
		if (source === undefined || target === undefined || source === target) continue;
		linkDistances[edgeCursor / 2] = discRadius(source) + discRadius(target) + 12;
		clusterEdges[edgeCursor++] = source;
		clusterEdges[edgeCursor++] = target;
	}
	const centers = computeForcePositions({
		dimensions: request.dimensions,
		edges: clusterEdges.subarray(0, edgeCursor),
		linkDistances: linkDistances.subarray(0, edgeCursor / 2),
		nodeCount: clusterCount,
		settings: request.settings,
	});
	const positions = new Float32Array(request.nodeCount * 3);
	for (let index = 0; index < request.nodeCount; index += 1) {
		const offset = index * 3;
		const cluster = request.clusters[index] ?? 0;
		const center = cluster * 3;
		const radius = discRadius(cluster) * Math.sqrt(random(index * 4 + 2));
		const angle = random(index * 4 + 1) * Math.PI * 2;
		positions[offset] = (centers[center] ?? 0) + Math.cos(angle) * radius;
		positions[offset + 1] = (centers[center + 1] ?? 0) + Math.sin(angle) * radius;
		if (request.dimensions === 3) {
			const zDirection = random(index * 4 + 3) * 2 - 1;
			positions[offset + 2] = (centers[center + 2] ?? 0) + zDirection * radius;
		}
	}
	return positions;
}

/**
 * Edge ends per node: the `"edge-t"` style draws one batch of samples per edge end. A self-loop counts
 * twice and every parallel edge counts; endpoints at or above `nodeCount` are skipped until
 * `addNodes()` recounts.
 */
function degreesOf(edges: Uint32Array, nodeCount: number) {
	const degrees = new Uint32Array(nodeCount);
	for (const index of edges) if (index < nodeCount) degrees[index] += 1;
	return degrees;
}

/** Node strengths are stored per node; `defaultStrength` covers nodes added without one. */
interface AnchorState {
	/** Mean of the anchored nodes' raw positions, per axis. */
	center: [number, number, number];
	defaultStrength: number;
	/** The host's anchor positions (`dimensions` per node, NaN = none), kept to re-derive `targets`. */
	raw: Float32Array;
	/** Raw units to layout units at the default link distance: base graph radius / largest distance from `center`. */
	rawScale: number;
	strengths: Float32Array;
	/** XYZ per node in layout units at the current link distance; NaN X means no anchor. */
	targets: Float32Array;
}

function isAnchored(positions: Float32Array, node: number, dimensions: number) {
	for (let axis = 0; axis < dimensions; axis += 1) {
		if (Number.isNaN(positions[node * dimensions + axis])) return false;
	}
	return true;
}

function assertAnchorPositions(positions: Float32Array, nodeCount: number, dimensions: number, subject: string) {
	if (positions.length !== nodeCount * dimensions) {
		throw new Error(
			`Anchor positions length (${positions.length}) must equal ${subject} (${nodeCount}) times dimensions (${dimensions}) = ${nodeCount * dimensions}.`,
		);
	}
	for (let index = 0; index < positions.length; index += 1) {
		const value = positions[index] ?? 0;
		if (Math.abs(value) === Infinity) {
			throw new Error(`Anchor positions must be finite or NaN (no anchor); found ${value} at index ${index}.`);
		}
	}
}

/** One strength per node: a number applies to all, an array must have one value per node. */
function resolveAnchorStrengths(strength: number | Float32Array | undefined, nodeCount: number) {
	const strengths = new Float32Array(nodeCount);
	if (strength === undefined || typeof strength === "number") {
		const value = strength ?? 1;
		assertAnchorStrength(value, "Anchor strength");
		strengths.fill(value);
		return strengths;
	}
	if (strength.length !== nodeCount) {
		throw new Error(`Anchor strength length (${strength.length}) must equal node count (${nodeCount}).`);
	}
	for (let index = 0; index < nodeCount; index += 1) {
		assertAnchorStrength(strength[index] ?? 0, `Anchor strength at index ${index}`);
	}
	strengths.set(strength);
	return strengths;
}

function assertAnchorStrength(value: number, subject: string) {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${subject} must be a finite number of at least 0; got ${value}.`);
	}
}

/** Graph radius grows with `linkDistance`, like the settled graph, relative to the default. */
function anchorScale(state: AnchorState, linkDistance: number) {
	return state.rawScale * (linkDistance / DEFAULT_FORCE_SETTINGS.linkDistance);
}

/** Maps raw anchors to layout units with the given transform; skipped nodes get NaN. */
function rescaleAnchors(positions: Float32Array, dimensions: 2 | 3, center: AnchorState["center"], scale: number) {
	const count = positions.length / dimensions;
	const targets = new Float32Array(count * 3).fill(Number.NaN);
	for (let node = 0; node < count; node += 1) {
		if (!isAnchored(positions, node, dimensions)) continue;
		for (let axis = 0; axis < 3; axis += 1) {
			targets[node * 3 + axis] =
				axis < dimensions ? ((positions[node * dimensions + axis] ?? 0) - (center[axis] ?? 0)) * scale : 0;
		}
	}
	return targets;
}

/**
 * Centres the anchored nodes on their mean and scales them so the farthest one sits at the expected
 * graph radius (`expectedGraphExtent / 2`, times `linkDistance / DEFAULT_FORCE_SETTINGS.linkDistance`),
 * so any host range (PCA in [-1, 1], UMAP in [-10, 10]) gives the same layout. The centre and raw scale
 * are computed once; `setSettings()` re-derives the targets when `linkDistance` changes.
 */
function createAnchorState(request: ForceLayoutRequest, anchors: ForceAnchors, linkDistance: number): AnchorState {
	const { dimensions, nodeCount } = request;
	assertAnchorPositions(anchors.positions, nodeCount, dimensions, "node count");
	const strengths = resolveAnchorStrengths(anchors.strength, nodeCount);
	const center: AnchorState["center"] = [0, 0, 0];
	let anchored = 0;
	for (let node = 0; node < nodeCount; node += 1) {
		if (!isAnchored(anchors.positions, node, dimensions)) continue;
		anchored += 1;
		for (let axis = 0; axis < dimensions; axis += 1) center[axis] += anchors.positions[node * dimensions + axis] ?? 0;
	}
	for (let axis = 0; axis < dimensions; axis += 1) center[axis] /= Math.max(1, anchored);
	let farthest = 0;
	for (let node = 0; node < nodeCount; node += 1) {
		if (!isAnchored(anchors.positions, node, dimensions)) continue;
		let squared = 0;
		for (let axis = 0; axis < dimensions; axis += 1) {
			squared += ((anchors.positions[node * dimensions + axis] ?? 0) - (center[axis] ?? 0)) ** 2;
		}
		farthest = Math.max(farthest, Math.sqrt(squared));
	}
	const rawScale = farthest > 0 ? expectedGraphExtent(nodeCount) / 2 / farthest : 0;
	const state: AnchorState = {
		center,
		defaultStrength: typeof anchors.strength === "number" ? anchors.strength : 1,
		raw: new Float32Array(anchors.positions),
		rawScale,
		strengths,
		targets: new Float32Array(0),
	};
	state.targets = rescaleAnchors(state.raw, dimensions, center, anchorScale(state, linkDistance));
	return state;
}

/**
 * Start anchored nodes at their anchor (plus 2% of the default start as jitter, so nodes sharing an
 * anchor can still separate). Nodes whose pull is off, or without an anchor, keep the default start.
 */
function seedAtAnchors(positions: Float32Array, state: AnchorState, anchorStrength: number, firstNode = 0) {
	if (anchorStrength <= 0) return;
	for (let node = firstNode; node < state.targets.length / 3; node += 1) {
		const offset = node * 3;
		if (Number.isNaN(state.targets[offset]) || (state.strengths[node] ?? 0) <= 0) continue;
		for (let axis = 0; axis < 3; axis += 1) {
			positions[offset + axis] = (state.targets[offset + axis] ?? 0) + (positions[offset + axis] ?? 0) * 0.02;
		}
	}
}

/** A running force layout; see `createForceSimulation()`. */
export interface ForceSimulation {
	/** Edge endpoint pairs, including edges added with `addEdges()`. */
	readonly edges: Uint32Array<ArrayBuffer>;
	/** Nodes in the simulation, including nodes added with `addNodes()`. */
	readonly nodeCount: number;
	/** XYZ per node; Z stays 0 in 2D. The array is replaced when nodes are added. */
	readonly positions: Float32Array<ArrayBuffer>;
	/** Effective settings after clamping and defaults. */
	readonly settings: Readonly<Required<ForceSettings>>;
	/**
	 * Add nodes while preserving every existing position and velocity. A simulation created with
	 * `clusters` requires one cluster index per added node (a new id starts a new cluster); a
	 * simulation created without clusters rejects them. A simulation created with `anchors` accepts
	 * anchors for the added nodes, in the same raw coordinates as the original anchors (they get the
	 * current centre and scale); added nodes without anchors are simply not pulled. A simulation
	 * created without anchors rejects them. Returns the index of the first added node.
	 */
	addNodes(count: number, initial?: Float32Array, clusters?: Uint32Array, anchors?: ForceAnchors): number;
	/** Append endpoint indices for new edges; existing edge indices remain stable. */
	addEdges(edges: Uint32Array): void;
	/**
	 * Change settings on a running simulation, including `layoutStyle`. `patch` is merged into the
	 * current settings; omitted fields keep their current value, and a NaN keeps the current value too.
	 * Positions, velocities, edges and clusters are kept, so the layout continues from where it is and
	 * relaxes into the new style over the next steps; nothing is re-seeded. Switching style changes the
	 * effective spring, cluster and repulsion forces at once (the layout guide lists the gains).
	 * Per-edge `linkDistances` and `springStrengths` given at creation are not re-derived; edges added
	 * later with `addEdges()` take the new `linkDistance` and `springStrength`. Anchor targets are
	 * rescaled to the new `linkDistance`. An unknown style
	 * throws and leaves the simulation unchanged.
	 */
	setSettings(patch: Partial<ForceSettings>): void;
	/** Advance one step; `alpha` scales every force and the speed limit. */
	step(alpha: number): void;
}

export function createForceSimulation(request: ForceLayoutRequest): ForceSimulation {
	let settings = normalizeForceSettings(request.settings);
	let nodeCount = request.nodeCount;
	let edges = new Uint32Array(request.edges);
	if (edges.length % 2 !== 0) throw new Error("Edges must contain source/target pairs.");
	let degrees = degreesOf(edges, nodeCount);
	const edgeCount = edges.length / 2;
	let linkDistances = normalizePerEdgeArray("linkDistances", request.linkDistances, edgeCount, 1, 500);
	let springStrengths = normalizePerEdgeArray("springStrengths", request.springStrengths, edgeCount, 0.0001, 0.05);
	let clusters: Uint32Array | null = null;
	if (request.clusters) {
		assertClusterCount(request.clusters, request.nodeCount, "node count");
		assertDenseClusterIds(request.clusters, request.nodeCount);
		clusters = new Uint32Array(request.clusters);
	}
	let positions = clusters ? clusteredInitialPositions({ ...request, clusters }) : initialPositions(request);
	let anchorState: AnchorState | null = request.anchors
		? createAnchorState(request, request.anchors, settings.linkDistance)
		: null;
	// A warm start goes on top of the anchor seeds, so placed nodes stay where they were.
	if (request.warmStart && anchorState) seedAtAnchors(positions, anchorState, settings.anchorStrength);
	if (request.initialPositions) applyInitialPositions(positions, request, request.initialPositions);
	if (!request.warmStart && anchorState) seedAtAnchors(positions, anchorState, settings.anchorStrength);
	let velocities = new Float32Array(positions.length);
	let forces = new Float32Array(positions.length);
	let iteration = 0;
	// Per-step scratch for cluster centroids; reallocated only when a new cluster id appears.
	let clusterCount = clusters ? clusterCountOf(clusters) : 0;
	let clusterCentroids = new Float64Array(clusterCount * 3);
	let clusterSizes = new Uint32Array(clusterCount);

	/** Mean position per cluster in O(N): no per-node allocation. */
	function updateClusterCentroids(activeClusters: Uint32Array) {
		clusterCentroids.fill(0);
		clusterSizes.fill(0);
		for (let index = 0; index < nodeCount; index += 1) {
			const cluster = activeClusters[index] ?? 0;
			const offset = index * 3;
			const centroid = cluster * 3;
			clusterSizes[cluster] += 1;
			clusterCentroids[centroid] += positions[offset] ?? 0;
			clusterCentroids[centroid + 1] += positions[offset + 1] ?? 0;
			clusterCentroids[centroid + 2] += positions[offset + 2] ?? 0;
		}
		for (let cluster = 0; cluster < clusterCount; cluster += 1) {
			const size = clusterSizes[cluster] ?? 0;
			if (size === 0) continue;
			for (let axis = 0; axis < request.dimensions; axis += 1) clusterCentroids[cluster * 3 + axis] /= size;
		}
	}
	/** `"classic"`: 8 sampled nodes per node, capped inverse-square push. */
	function applyClassicRepulsion(alpha: number) {
		for (let index = 0; index < nodeCount; index += 1) {
			const offset = index * 3;
			for (let sample = 0; sample < 8; sample += 1) {
				const targetIndex = Math.floor(random(index * 97 + sample * 17 + iteration * 13) * nodeCount);
				if (targetIndex === index) continue;
				const target = targetIndex * 3;
				const dx = (positions[offset] ?? 0) - (positions[target] ?? 0);
				const dy = (positions[offset + 1] ?? 0) - (positions[target + 1] ?? 0);
				const dz = request.dimensions === 3 ? (positions[offset + 2] ?? 0) - (positions[target + 2] ?? 0) : 0;
				const distanceSquared = dx * dx + dy * dy + dz * dz + 16;
				const scale = (Math.min(2, settings.repulsion / distanceSquared) * alpha) / Math.sqrt(distanceSquared);
				forces[offset] += dx * scale;
				forces[offset + 1] += dy * scale;
				forces[offset + 2] += dz * scale;
			}
		}
	}

	/**
	 * `"edge-t"`: every edge end draws `negativeSamples` uniform nodes, so a node wants
	 * `negativeSamples * degree` draws (isolated nodes count as degree 1), capped at
	 * `MAX_EDGE_T_DRAWS_PER_NODE` with the push scaled up to match. Only the drawing node moves, and the
	 * degree weight is on that node only, unlike the paper's `(d_i + d_j) / 2|V|`. The push is the
	 * bounded Student-t kernel `r / (1 + r² / ν)^((ν + 1) / 2)` with `r` in link distances: it peaks near
	 * one link distance and decays as `r^-ν`, so it never explodes at short range and still separates
	 * far groups.
	 */
	function applyEdgeTRepulsion(alpha: number) {
		const samples = settings.negativeSamples;
		const nu = settings.tDegrees;
		const exponent = (nu + 1) / 2;
		const unit = settings.linkDistance;
		const strength =
			(settings.repulsion / DEFAULT_FORCE_SETTINGS.repulsion) *
			FORCE_LAYOUT_STYLE_PRESETS["edge-t"].repulsionGain *
			alpha;
		const stepSeed = hash32(iteration + 0x5bd1e995);
		// A cluster's push from other clusters shrinks with its size: with the full push a small cluster is
		// driven far from the rest by the mass around it, leaving a wider empty margin than a large one (#192).
		for (let index = 0; index < nodeCount; index += 1) {
			const offset = index * 3;
			const cluster = clusters?.[index];
			const ownScale = (((clusterSizes[cluster ?? 0] ?? 0) * clusterCount) / nodeCount) ** 0.25;
			const degree = Math.max(1, degrees[index] ?? 0);
			const draws = Math.min(MAX_EDGE_T_DRAWS_PER_NODE, samples * degree);
			// Each draw stands for `degree / draws` edge ends, so a capped hub keeps its expected push.
			const weight = (strength * degree) / draws;
			// One hash per node and step, then consecutive seeds: hubs never share seeds with neighbours.
			const nodeSeed = hash32(Math.imul(index, 0x27d4eb2d) ^ stepSeed);
			for (let sample = 0; sample < draws; sample += 1) {
				const targetIndex = Math.floor(random(nodeSeed + sample) * nodeCount);
				if (targetIndex === index) continue;
				const target = targetIndex * 3;
				const dx = (positions[offset] ?? 0) - (positions[target] ?? 0);
				const dy = (positions[offset + 1] ?? 0) - (positions[target + 1] ?? 0);
				const dz = request.dimensions === 3 ? (positions[offset + 2] ?? 0) - (positions[target + 2] ?? 0) : 0;
				const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.0001;
				const r = distance / unit;
				const kernel = nu === 1 ? r / (1 + r * r) : r / (1 + (r * r) / nu) ** exponent;
				const scale = (weight * kernel * (cluster === clusters?.[targetIndex] ? 1 : ownScale)) / distance;
				forces[offset] += dx * scale;
				forces[offset + 1] += dy * scale;
				forces[offset + 2] += dz * scale;
			}
		}
	}

	return {
		get settings(): Readonly<Required<ForceSettings>> {
			return settings;
		},
		setSettings(patch: Partial<ForceSettings>) {
			const previousLinkDistance = settings.linkDistance;
			settings = normalizeForceSettings({ ...settings, ...patch }, settings);
			if (anchorState && settings.linkDistance !== previousLinkDistance) {
				anchorState.targets = rescaleAnchors(
					anchorState.raw,
					request.dimensions,
					anchorState.center,
					anchorScale(anchorState, settings.linkDistance),
				);
			}
		},
		get nodeCount() {
			return nodeCount;
		},
		get edges() {
			return edges;
		},
		get positions() {
			return positions;
		},
		addNodes(count: number, initial?: Float32Array, addedClusters?: Uint32Array, addedAnchors?: ForceAnchors) {
			if (!Number.isSafeInteger(count) || count < 1) throw new Error("Count must be a positive integer.");
			if (initial && initial.length !== count * 3) {
				throw new Error("Initial positions must be count * 3.");
			}
			if (clusters && !addedClusters) {
				throw new Error("This simulation was created with clusters: addNodes() requires a clusters array.");
			}
			if (!clusters && addedClusters) {
				throw new Error("This simulation was created without clusters: addNodes() cannot take a clusters array.");
			}
			if (addedClusters) {
				assertClusterCount(addedClusters, count, "added node count");
				assertDenseClusterIds(addedClusters, nodeCount + count);
			}
			if (addedAnchors && !anchorState) {
				throw new Error("This simulation was created without anchors: addNodes() cannot take anchors.");
			}
			let nextAnchorState = anchorState;
			if (anchorState) {
				if (addedAnchors) assertAnchorPositions(addedAnchors.positions, count, request.dimensions, "added node count");
				const addedStrengths = addedAnchors
					? resolveAnchorStrengths(addedAnchors.strength ?? anchorState.defaultStrength, count)
					: new Float32Array(count);
				const addedTargets = addedAnchors
					? rescaleAnchors(
							addedAnchors.positions,
							request.dimensions,
							anchorState.center,
							anchorScale(anchorState, settings.linkDistance),
						)
					: new Float32Array(count * 3).fill(Number.NaN);
				const strengths = new Float32Array(nodeCount + count);
				strengths.set(anchorState.strengths);
				strengths.set(addedStrengths, nodeCount);
				const targets = new Float32Array((nodeCount + count) * 3);
				targets.set(anchorState.targets);
				targets.set(addedTargets, nodeCount * 3);
				const raw = new Float32Array((nodeCount + count) * request.dimensions).fill(Number.NaN);
				raw.set(anchorState.raw);
				if (addedAnchors) raw.set(addedAnchors.positions, nodeCount * request.dimensions);
				nextAnchorState = { ...anchorState, raw, strengths, targets };
			}
			const start = nodeCount;
			const nextPositions = new Float32Array((nodeCount + count) * 3);
			nextPositions.set(positions);
			const nextVelocities = new Float32Array(nextPositions.length);
			nextVelocities.set(velocities);
			const nextForces = new Float32Array(nextPositions.length);
			if (initial) nextPositions.set(initial, positions.length);
			else {
				const added = initialPositions({ dimensions: request.dimensions, nodeCount: count });
				nextPositions.set(added, positions.length);
			}
			// Allocate every next array before assigning any state, so a throw leaves the simulation intact.
			let nextClusters = clusters;
			let nextClusterCount = clusterCount;
			let nextCentroids = clusterCentroids;
			let nextSizes = clusterSizes;
			if (clusters && addedClusters) {
				nextClusters = new Uint32Array(nodeCount + count);
				nextClusters.set(clusters);
				nextClusters.set(addedClusters, nodeCount);
				nextClusterCount = Math.max(clusterCount, clusterCountOf(addedClusters));
				if (nextClusterCount !== clusterCount) {
					nextCentroids = new Float64Array(nextClusterCount * 3);
					nextSizes = new Uint32Array(nextClusterCount);
				}
			}
			if (nextAnchorState && !initial) seedAtAnchors(nextPositions, nextAnchorState, settings.anchorStrength, start);
			anchorState = nextAnchorState;
			clusters = nextClusters;
			clusterCount = nextClusterCount;
			clusterCentroids = nextCentroids;
			clusterSizes = nextSizes;
			degrees = degreesOf(edges, nodeCount + count);
			positions = nextPositions;
			velocities = nextVelocities;
			forces = nextForces;
			nodeCount += count;
			return start;
		},
		addEdges(nextEdges: Uint32Array) {
			if (nextEdges.length % 2 !== 0) throw new Error("Edges must contain source/target pairs.");
			for (const index of nextEdges) {
				if (index >= nodeCount) throw new Error(`Edge references missing node: ${index}`);
			}
			const addedEdgeCount = nextEdges.length / 2;
			const merged = new Uint32Array(edges.length + nextEdges.length);
			merged.set(edges);
			merged.set(nextEdges, edges.length);
			edges = merged;
			for (const index of nextEdges) degrees[index] += 1;
			if (linkDistances) {
				const next = new Float32Array(linkDistances.length + addedEdgeCount);
				next.set(linkDistances);
				next.fill(settings.linkDistance, linkDistances.length);
				linkDistances = next;
			}
			if (springStrengths) {
				const next = new Float32Array(springStrengths.length + addedEdgeCount);
				next.set(springStrengths);
				next.fill(settings.springStrength, springStrengths.length);
				springStrengths = next;
			}
		},
		step(alpha: number) {
			if (nodeCount === 0) return;
			forces.fill(0);
			const pullClusters = clusters && settings.clusterStrength > 0 ? clusters : null;
			const preset = FORCE_LAYOUT_STYLE_PRESETS[settings.layoutStyle];
			const clusterPull = settings.clusterStrength * preset.clusterGain * alpha;
			const anchors = anchorState && settings.anchorStrength > 0 ? anchorState : null;
			const anchorPull = settings.anchorStrength * alpha;
			if (clusters) updateClusterCentroids(clusters);
			for (let index = 0; index < nodeCount; index += 1) {
				const offset = index * 3;
				// In 2D the z force is never read: z velocity stays 0.
				for (let axis = 0; axis < 3; axis += 1) {
					forces[offset + axis] = -(positions[offset + axis] ?? 0) * settings.centerAttraction * alpha;
				}
				if (pullClusters) {
					const centroid = (pullClusters[index] ?? 0) * 3;
					for (let axis = 0; axis < request.dimensions; axis += 1) {
						forces[offset + axis] +=
							((clusterCentroids[centroid + axis] ?? 0) - (positions[offset + axis] ?? 0)) * clusterPull;
					}
				}
			}
			if (anchors) {
				for (let index = 0; index < nodeCount; index += 1) {
					const offset = index * 3;
					if (Number.isNaN(anchors.targets[offset])) continue;
					const pull = anchorPull * (anchors.strengths[index] ?? 0);
					for (let axis = 0; axis < request.dimensions; axis += 1) {
						forces[offset + axis] += ((anchors.targets[offset + axis] ?? 0) - (positions[offset + axis] ?? 0)) * pull;
					}
				}
			}
			if (preset.repulsion === "edge-sampled-student-t") applyEdgeTRepulsion(alpha);
			else applyClassicRepulsion(alpha);
			const springGain = preset.springGain;
			for (let index = 0; index < edges.length; index += 2) {
				const edgeIndex = index / 2;
				const source = (edges[index] ?? 0) * 3;
				const target = (edges[index + 1] ?? 0) * 3;
				const dx = (positions[target] ?? 0) - (positions[source] ?? 0);
				const dy = (positions[target + 1] ?? 0) - (positions[source + 1] ?? 0);
				const dz = request.dimensions === 3 ? (positions[target + 2] ?? 0) - (positions[source + 2] ?? 0) : 0;
				const distance = Math.sqrt(Math.max(dx * dx + dy * dy + dz * dz, 0.0001));
				const linkDistance = linkDistances?.[edgeIndex] ?? settings.linkDistance;
				const springStrength = (springStrengths?.[edgeIndex] ?? settings.springStrength) * springGain;
				const force = Math.max(-1, Math.min(1, (distance - linkDistance) * springStrength * alpha)) / distance;
				forces[source] += dx * force;
				forces[source + 1] += dy * force;
				forces[target] -= dx * force;
				forces[target + 1] -= dy * force;
				forces[source + 2] += dz * force;
				forces[target + 2] -= dz * force;
			}
			for (let index = 0; index < nodeCount; index += 1) {
				const offset = index * 3;
				let vx = ((velocities[offset] ?? 0) + (forces[offset] ?? 0)) * settings.damping;
				let vy = ((velocities[offset + 1] ?? 0) + (forces[offset + 1] ?? 0)) * settings.damping;
				let vz =
					request.dimensions === 3 ? ((velocities[offset + 2] ?? 0) + (forces[offset + 2] ?? 0)) * settings.damping : 0;
				const speed = Math.hypot(vx, vy, vz);
				const maxSpeed = 0.5 + alpha * 8;
				if (speed > maxSpeed) {
					const scale = maxSpeed / speed;
					vx *= scale;
					vy *= scale;
					vz *= scale;
				}
				velocities[offset] = vx;
				velocities[offset + 1] = vy;
				velocities[offset + 2] = vz;
				positions[offset] = (positions[offset] ?? 0) + vx;
				positions[offset + 1] = (positions[offset + 1] ?? 0) + vy;
				positions[offset + 2] = request.dimensions === 3 ? (positions[offset + 2] ?? 0) + vz : 0;
			}
			const center = [0, 0, 0];
			for (let index = 0; index < nodeCount; index += 1) {
				const offset = index * 3;
				center[0] += positions[offset] ?? 0;
				center[1] += positions[offset + 1] ?? 0;
				center[2] += positions[offset + 2] ?? 0;
			}
			for (let axis = 0; axis < request.dimensions; axis += 1) center[axis] /= nodeCount;
			for (let index = 0; index < nodeCount; index += 1) {
				const offset = index * 3;
				for (let axis = 0; axis < request.dimensions; axis += 1) positions[offset + axis] -= center[axis];
			}
			iteration += 1;
		},
	};
}

export function computeForcePositions(request: ForceLayoutRequest) {
	const simulation = createForceSimulation(request);
	const full = resolveForceIterations(request.nodeCount, simulation.settings.layoutStyle, request.iterations);
	const warm = request.warmStart;
	// A warm start settles from alpha 0.05, in 6 steps, so placed nodes barely move.
	const iterations = warm ? 6 : full;
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		simulation.step((warm ? 0.05 : 1) * (1 - iteration / iterations));
	}
	return simulation.positions;
}

export function computeClusteredForcePositions(request: ForceLayoutRequest & { clusters: Uint32Array }) {
	assertClusterCount(request.clusters, request.nodeCount, "node count");
	return clusteredInitialPositions(request);
}
