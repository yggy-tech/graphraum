/** Input for graphraum's dimension-aware force layout helpers. */
export interface ForceLayoutRequest {
	dimensions: 2 | 3;
	edges: Uint32Array;
	/**
	 * When omitted, `forceIterationCount(nodeCount)` is used, times 8 for `repulsionModel: "edge-t"`.
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
	settings?: ForceSettings;
	/**
	 * Optional spring strength per edge (`edges.length / 2` values).
	 * Omitted → `settings.springStrength` for every edge.
	 */
	springStrengths?: Float32Array;
}

/**
 * How a force layout pushes nodes apart. Each model is a named layout style; new styles are added as
 * new names, so a consumer's choice keeps its meaning across releases.
 *
 * - `"classic"`: every node is pushed away from 8 sampled nodes with a capped inverse-square force,
 *   whatever its degree. The default.
 * - `"edge-t"`: edge-centric negative sampling with a bounded Student-t force (SNAP-tFDP, #191). Each
 *   edge pushes both endpoints away from `negativeSamples` sampled nodes, so repulsion grows with
 *   degree and dense groups separate. Still O(|E| + |V|) per step, no spatial tree.
 */
export type ForceRepulsionModel = "classic" | "edge-t";

/** Every supported {@link ForceRepulsionModel}, in documentation order. */
export const FORCE_REPULSION_MODELS: readonly ForceRepulsionModel[] = ["classic", "edge-t"];

export interface ForceSettings {
	centerAttraction: number;
	/**
	 * Pull of every node towards its cluster centroid, scaled by the step alpha.
	 * `0` disables the pull. Ignored without `clusters`.
	 * Omitted → `DEFAULT_FORCE_SETTINGS.clusterStrength`.
	 */
	clusterStrength?: number;
	damping: number;
	linkDistance: number;
	/**
	 * `"edge-t"` only: sampled nodes per edge endpoint and step, an integer from 1 to 16. More samples
	 * give a smoother push at a linear cost. Omitted → `DEFAULT_FORCE_SETTINGS.negativeSamples`.
	 */
	negativeSamples?: number;
	repulsion: number;
	/**
	 * Repulsion style. Omitted → `"classic"`. Unknown names throw. See {@link ForceRepulsionModel}.
	 */
	repulsionModel?: ForceRepulsionModel;
	springStrength: number;
	/**
	 * `"edge-t"` only: degrees of freedom of the Student-t force, from 0.5 to 10. Lower values give a
	 * heavier tail, so distant groups keep pushing each other apart. Omitted →
	 * `DEFAULT_FORCE_SETTINGS.tDegrees`.
	 */
	tDegrees?: number;
}

export const DEFAULT_FORCE_SETTINGS: Required<ForceSettings> = {
	centerAttraction: 0.002,
	clusterStrength: 0.02,
	damping: 0.82,
	linkDistance: 24,
	negativeSamples: 2,
	repulsion: 400,
	repulsionModel: "classic",
	springStrength: 0.005,
	tDegrees: 1,
};

function resolveRepulsionModel(model: ForceRepulsionModel | undefined): ForceRepulsionModel {
	if (model === undefined) return DEFAULT_FORCE_SETTINGS.repulsionModel;
	if (!FORCE_REPULSION_MODELS.includes(model)) {
		throw new Error(`Unknown repulsionModel "${model}"; use one of: ${FORCE_REPULSION_MODELS.join(", ")}.`);
	}
	return model;
}

function finiteOr(value: number | undefined, fallback: number) {
	return value === undefined || Number.isNaN(value) ? fallback : value;
}

function normalizeForceSettings(settings: ForceSettings = DEFAULT_FORCE_SETTINGS): Required<ForceSettings> {
	return {
		centerAttraction: Math.max(0, Math.min(0.05, settings.centerAttraction)),
		clusterStrength: Math.max(0, Math.min(0.1, settings.clusterStrength ?? DEFAULT_FORCE_SETTINGS.clusterStrength)),
		damping: Math.max(0.1, Math.min(0.99, settings.damping)),
		linkDistance: Math.max(1, Math.min(500, settings.linkDistance)),
		negativeSamples: Math.max(
			1,
			Math.min(16, Math.round(finiteOr(settings.negativeSamples, DEFAULT_FORCE_SETTINGS.negativeSamples))),
		),
		repulsion: Math.max(0, Math.min(5_000, settings.repulsion)),
		repulsionModel: resolveRepulsionModel(settings.repulsionModel),
		springStrength: Math.max(0.0001, Math.min(0.05, settings.springStrength)),
		tDegrees: Math.max(0.5, Math.min(10, finiteOr(settings.tDegrees, DEFAULT_FORCE_SETTINGS.tDegrees))),
	};
}

/**
 * Per-style constants, one row per {@link ForceRepulsionModel}. Tuned on the deterministic quality
 * fixtures in `force-layout.quality.test.ts`; a new style adds a row here and a branch in `step()`.
 *
 * - `clusterGain` multiplies `clusterStrength`, so the cluster pull keeps its weight against the
 *   stronger `"edge-t"` forces.
 * - `springGain` multiplies `springStrength` (and per-edge strengths). The bounded `"edge-t"` push is
 *   stronger on average than the capped classic one, so its springs are stronger too.
 * - `repulsionGain` scales the `"edge-t"` kernel at the default `repulsion`.
 * - `iterationScale` multiplies `forceIterationCount()` for the one-shot default: the classic style
 *   stops improving after a few dozen steps; `"edge-t"` keeps separating groups for longer.
 * - `maxIterations` caps an explicit `iterations` request.
 */
const STYLE_CONSTANTS: Record<
	ForceRepulsionModel,
	{
		clusterGain: number;
		iterationScale: number;
		maxIterations: number;
		repulsionGain: number;
		springGain: number;
	}
> = {
	classic: { clusterGain: 1, iterationScale: 1, maxIterations: 64, repulsionGain: 1, springGain: 1 },
	"edge-t": { clusterGain: 2.5, iterationScale: 8, maxIterations: 512, repulsionGain: 4, springGain: 10 },
};

function clampLinkDistance(value: number): number {
	return Math.max(1, Math.min(500, value));
}

function clampSpringStrength(value: number): number {
	return Math.max(0.0001, Math.min(0.05, value));
}

function normalizePerEdgeArray(
	name: "linkDistances" | "springStrengths",
	values: Float32Array | undefined,
	edgeCount: number,
	clamp: (value: number) => number,
): Float32Array | null {
	if (values === undefined) return null;
	if (values.length !== edgeCount) {
		throw new Error(`${name} length (${values.length}) must equal edge count (${edgeCount}).`);
	}
	const normalized = new Float32Array(edgeCount);
	for (let index = 0; index < edgeCount; index += 1) {
		normalized[index] = clamp(values[index] ?? 0);
	}
	return normalized;
}

export function forceIterationCount(nodeCount: number) {
	return Math.max(8, Math.min(32, Math.ceil(240 / Math.log2(nodeCount + 2))));
}

function resolveForceIterations(nodeCount: number, model: ForceRepulsionModel, iterations?: number) {
	const style = STYLE_CONSTANTS[model];
	if (iterations === undefined) return forceIterationCount(nodeCount) * style.iterationScale;
	if (!Number.isSafeInteger(iterations) || iterations < 1) {
		throw new Error("Force iterations must be a positive integer.");
	}
	return Math.min(style.maxIterations, iterations);
}

function initialPositions({ dimensions, nodeCount }: Pick<ForceLayoutRequest, "dimensions" | "nodeCount">) {
	const positions = new Float32Array(nodeCount * 3);
	const extent = Math.max(Math.sqrt(nodeCount) * 6, 24);
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

function random(seed: number) {
	let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
	value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
	return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
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
	let clusterCount = 0;
	for (const cluster of clusters) clusterCount = Math.max(clusterCount, cluster + 1);
	return clusterCount;
}

/**
 * Seeds nodes around cluster centres: centres come from a force layout of the inter-cluster graph
 * and each node is scattered around its centre. Shared by the one-shot and live clustered layouts.
 */
function clusteredInitialPositions(request: ForceLayoutRequest & { clusters: Uint32Array }) {
	const clusterCount = clusterCountOf(request.clusters);
	const clusterEdges = new Uint32Array(request.edges.length);
	let edgeCursor = 0;
	for (let index = 0; index < request.edges.length; index += 2) {
		const source = request.clusters[request.edges[index] ?? 0];
		const target = request.clusters[request.edges[index + 1] ?? 0];
		if (source === undefined || target === undefined || source === target) continue;
		clusterEdges[edgeCursor++] = source;
		clusterEdges[edgeCursor++] = target;
	}
	const centers = computeForcePositions({
		dimensions: request.dimensions,
		edges: clusterEdges.subarray(0, edgeCursor),
		nodeCount: clusterCount,
		settings: request.settings,
	});
	const clusterSizes = new Uint32Array(clusterCount);
	for (const cluster of request.clusters) clusterSizes[cluster] += 1;
	const positions = new Float32Array(request.nodeCount * 3);
	for (let index = 0; index < request.nodeCount; index += 1) {
		const offset = index * 3;
		const cluster = request.clusters[index] ?? 0;
		const center = cluster * 3;
		const radius = Math.sqrt(clusterSizes[cluster] ?? 1) * Math.sqrt(random(index * 4 + 2)) * 2;
		const angle = random(index * 4 + 1) * Math.PI * 2;
		positions[offset] = (centers[center] ?? 0) * 12 + Math.cos(angle) * radius;
		positions[offset + 1] = (centers[center + 1] ?? 0) * 12 + Math.sin(angle) * radius;
		if (request.dimensions === 3) {
			const zDirection = random(index * 4 + 3) * 2 - 1;
			positions[offset + 2] = (centers[center + 2] ?? 0) * 12 + zDirection * radius;
		}
	}
	return positions;
}

/** Edge count per node; the `"edge-t"` style draws one batch of samples per edge end. */
function degreesOf(edges: Uint32Array, nodeCount: number) {
	const degrees = new Uint32Array(nodeCount);
	for (const index of edges) if (index < nodeCount) degrees[index] += 1;
	return degrees;
}

export function createForceSimulation(request: ForceLayoutRequest) {
	let settings = normalizeForceSettings(request.settings);
	let nodeCount = request.nodeCount;
	let edges = new Uint32Array(request.edges);
	if (edges.length % 2 !== 0) throw new Error("Force edges must contain source/target pairs.");
	let degrees = degreesOf(edges, nodeCount);
	const edgeCount = edges.length / 2;
	let linkDistances = normalizePerEdgeArray("linkDistances", request.linkDistances, edgeCount, clampLinkDistance);
	let springStrengths = normalizePerEdgeArray(
		"springStrengths",
		request.springStrengths,
		edgeCount,
		clampSpringStrength,
	);
	let clusters: Uint32Array | null = null;
	if (request.clusters) {
		assertClusterCount(request.clusters, request.nodeCount, "node count");
		assertDenseClusterIds(request.clusters, request.nodeCount);
		clusters = new Uint32Array(request.clusters);
	}
	let positions = clusters ? clusteredInitialPositions({ ...request, clusters }) : initialPositions(request);
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
			if (request.dimensions === 3) clusterCentroids[centroid + 2] += positions[offset + 2] ?? 0;
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
				if (request.dimensions === 3) forces[offset + 2] += dz * scale;
			}
		}
	}

	/**
	 * `"edge-t"`: every edge endpoint draws `negativeSamples` uniform nodes, so a node gets
	 * `negativeSamples * degree` pushes (isolated nodes count as degree 1). The push is the bounded
	 * Student-t kernel `r / (1 + r² / ν)^((ν + 1) / 2)` with `r` in link distances: it peaks near one link
	 * distance and decays as `r^-ν`, so it never explodes at short range and still separates far groups.
	 */
	function applyEdgeTRepulsion(alpha: number) {
		const samples = settings.negativeSamples;
		const nu = settings.tDegrees;
		const exponent = (nu + 1) / 2;
		const unit = settings.linkDistance;
		const strength =
			(settings.repulsion / DEFAULT_FORCE_SETTINGS.repulsion) * STYLE_CONSTANTS["edge-t"].repulsionGain * alpha;
		for (let index = 0; index < nodeCount; index += 1) {
			const offset = index * 3;
			const draws = samples * Math.max(1, degrees[index] ?? 0);
			for (let sample = 0; sample < draws; sample += 1) {
				const targetIndex = Math.floor(random(index * 7919 + sample * 131 + iteration * 104_729) * nodeCount);
				if (targetIndex === index) continue;
				const target = targetIndex * 3;
				const dx = (positions[offset] ?? 0) - (positions[target] ?? 0);
				const dy = (positions[offset + 1] ?? 0) - (positions[target + 1] ?? 0);
				const dz = request.dimensions === 3 ? (positions[offset + 2] ?? 0) - (positions[target + 2] ?? 0) : 0;
				const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.0001;
				const r = distance / unit;
				const kernel = nu === 1 ? r / (1 + r * r) : r / (1 + (r * r) / nu) ** exponent;
				const scale = (strength * kernel) / (samples * distance);
				forces[offset] += dx * scale;
				forces[offset + 1] += dy * scale;
				if (request.dimensions === 3) forces[offset + 2] += dz * scale;
			}
		}
	}

	return {
		/** Effective settings after clamping and defaults. */
		get settings(): Readonly<Required<ForceSettings>> {
			return settings;
		},
		/**
		 * Switch settings, including `repulsionModel`, on a running simulation. Positions, velocities,
		 * edges, clusters and per-edge arrays are kept, so the layout continues from where it is and
		 * relaxes into the new style over the next steps; nothing is re-seeded. Invalid values are
		 * clamped like at creation; an unknown model throws and leaves the simulation unchanged.
		 */
		setSettings(next: ForceSettings) {
			settings = normalizeForceSettings(next);
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
		/**
		 * Add nodes while preserving every existing position and velocity. A simulation created with
		 * `clusters` requires one cluster index per added node (a new id starts a new cluster); a
		 * simulation created without clusters rejects them.
		 */
		addNodes(count: number, initial?: Float32Array, addedClusters?: Uint32Array) {
			if (!Number.isSafeInteger(count) || count < 1) throw new Error("Node count must be a positive integer.");
			if (initial && initial.length !== count * 3) {
				throw new Error("Initial positions must contain one XYZ triplet per added node.");
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
			const start = nodeCount;
			const nextPositions = new Float32Array((nodeCount + count) * 3);
			nextPositions.set(positions);
			const nextVelocities = new Float32Array(nextPositions.length);
			nextVelocities.set(velocities);
			const nextForces = new Float32Array(nextPositions.length);
			nextForces.set(forces);
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
			clusters = nextClusters;
			clusterCount = nextClusterCount;
			clusterCentroids = nextCentroids;
			clusterSizes = nextSizes;
			const nextDegrees = new Uint32Array(nodeCount + count);
			nextDegrees.set(degrees);
			degrees = nextDegrees;
			positions = nextPositions;
			velocities = nextVelocities;
			forces = nextForces;
			nodeCount += count;
			return start;
		},
		/** Append endpoint indices for new edges; existing edge indices remain stable. */
		addEdges(nextEdges: Uint32Array) {
			if (nextEdges.length % 2 !== 0) throw new Error("Force edges must contain source/target pairs.");
			for (const index of nextEdges) {
				if (index >= nodeCount) throw new Error(`Force edge references missing node index: ${index}`);
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
			const clusterPull = settings.clusterStrength * STYLE_CONSTANTS[settings.repulsionModel].clusterGain * alpha;
			if (pullClusters) updateClusterCentroids(pullClusters);
			for (let index = 0; index < nodeCount; index += 1) {
				const offset = index * 3;
				forces[offset] = -(positions[offset] ?? 0) * settings.centerAttraction * alpha;
				forces[offset + 1] = -(positions[offset + 1] ?? 0) * settings.centerAttraction * alpha;
				forces[offset + 2] =
					request.dimensions === 3 ? -(positions[offset + 2] ?? 0) * settings.centerAttraction * alpha : 0;
				if (pullClusters) {
					const centroid = (pullClusters[index] ?? 0) * 3;
					for (let axis = 0; axis < request.dimensions; axis += 1) {
						forces[offset + axis] +=
							((clusterCentroids[centroid + axis] ?? 0) - (positions[offset + axis] ?? 0)) * clusterPull;
					}
				}
			}
			if (settings.repulsionModel === "edge-t") applyEdgeTRepulsion(alpha);
			else applyClassicRepulsion(alpha);
			const springGain = STYLE_CONSTANTS[settings.repulsionModel].springGain;
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
				if (request.dimensions === 3) {
					forces[source + 2] += dz * force;
					forces[target + 2] -= dz * force;
				}
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
				if (request.dimensions === 3) center[2] += positions[offset + 2] ?? 0;
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
	const iterations = resolveForceIterations(request.nodeCount, simulation.settings.repulsionModel, request.iterations);
	for (let iteration = 0; iteration < iterations; iteration += 1) simulation.step(1 - iteration / iterations);
	return simulation.positions;
}

export function computeClusteredForcePositions(request: ForceLayoutRequest & { clusters: Uint32Array }) {
	assertClusterCount(request.clusters, request.nodeCount, "node count");
	return clusteredInitialPositions(request);
}
