import type { ClusterTree } from "./cluster-tree";

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

/** The elements a cut draws: cluster ids and real node indices. */
export interface CutElements {
	clusters: ReadonlySet<number>;
	nodes: ReadonlySet<number>;
}

export const clusterKey = (cluster: number) => `c${cluster}`;
export const nodeKey = (node: number) => `n${node}`;

export interface TransitionPlan {
	/** Elements of the new cut that grow in place because the elements below them merge into them. */
	growing: string[];
	/** Elements of the new cut that start at the position of the old cluster that split into them. */
	entering: { from: Vec3; key: string }[];
	/** Elements of the old cut that shrink away. `to` is where they travel (the cluster they merge into), or null to stay. */
	leaving: { key: string; to: Vec3 | null }[];
}

export const EMPTY_PLAN: TransitionPlan = { entering: [], growing: [], leaving: [] };

export function planIsEmpty(plan: TransitionPlan) {
	return plan.entering.length + plan.growing.length + plan.leaving.length === 0;
}

/** The first cluster above `start` (exclusive when `includeStart` is false) that `wanted` accepts. */
function ancestorWhere(tree: ClusterTree, start: number, wanted: (cluster: number) => boolean, includeStart: boolean) {
	for (
		let cluster = includeStart ? start : (tree.parent[start] as number);
		cluster >= 0;
		cluster = tree.parent[cluster] as number
	) {
		if (wanted(cluster)) return cluster;
	}
	return -1;
}

/**
 * Pairs the elements that a cut change replaces. A cluster that splits has its children start at its
 * position while it shrinks away; children that merge into a cluster travel to it while it grows.
 * Elements that only enter or leave, as on a pan, are not paired and swap at once.
 *
 * `centroid` gives where a cluster sits and `nodePosition` where a real node sits.
 */
export function planTransition(
	tree: ClusterTree,
	before: CutElements,
	after: CutElements,
	centroid: (cluster: number) => Vec3,
): TransitionPlan {
	const plan: TransitionPlan = { entering: [], growing: [], leaving: [] };
	const splitParents = new Set<number>();
	const enter = (key: string, start: number, includeStart: boolean) => {
		const parent = ancestorWhere(
			tree,
			start,
			(cluster) => before.clusters.has(cluster) && !after.clusters.has(cluster),
			includeStart,
		);
		if (parent < 0) return;
		splitParents.add(parent);
		plan.entering.push({ from: centroid(parent), key });
	};
	for (const cluster of after.clusters) if (!before.clusters.has(cluster)) enter(clusterKey(cluster), cluster, false);
	for (const node of after.nodes) if (!before.nodes.has(node)) enter(nodeKey(node), tree.leafOf[node] as number, true);

	const mergedInto = new Set<number>();
	const leave = (key: string, start: number, includeStart: boolean) => {
		const target = ancestorWhere(tree, start, (cluster) => after.clusters.has(cluster), includeStart);
		if (target >= 0) {
			mergedInto.add(target);
			plan.leaving.push({ key, to: centroid(target) });
		}
	};
	for (const cluster of before.clusters) {
		if (after.clusters.has(cluster)) continue;
		if (splitParents.has(cluster)) plan.leaving.push({ key: clusterKey(cluster), to: null });
		else leave(clusterKey(cluster), cluster, false);
	}
	for (const node of before.nodes) {
		if (!after.nodes.has(node)) leave(nodeKey(node), tree.leafOf[node] as number, true);
	}
	plan.growing = [...mergedInto].map(clusterKey);
	return plan;
}

/** Smallest scale an animated glyph is drawn at, so a size is never zero. */
export const MINIMUM_SCALE = 0.15;

const ease = (progress: number) => (progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2);
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;

export interface TransitionSample {
	key: string;
	position: Vec3;
	/** Fraction of the element's own size, between `MINIMUM_SCALE` and 1. */
	scale: number;
}

/** Where every element of the plan is at `progress` (0..1). `place` gives the final position of a key. */
export function sampleTransition(
	plan: TransitionPlan,
	progress: number,
	place: (key: string) => Vec3,
): TransitionSample[] {
	const eased = ease(Math.min(Math.max(progress, 0), 1));
	const grow = mix(MINIMUM_SCALE, 1, eased);
	const shrink = mix(1, MINIMUM_SCALE, eased);
	return [
		...plan.entering.map(({ from, key }) => {
			const to = place(key);
			return {
				key,
				position: { x: mix(from.x, to.x, eased), y: mix(from.y, to.y, eased), z: mix(from.z, to.z, eased) },
				scale: grow,
			};
		}),
		...plan.growing.map((key) => ({ key, position: place(key), scale: grow })),
		...plan.leaving.map(({ key, to }) => {
			const from = place(key);
			const position = to
				? { x: mix(from.x, to.x, eased), y: mix(from.y, to.y, eased), z: mix(from.z, to.z, eased) }
				: from;
			return { key, position, scale: shrink };
		}),
	];
}
