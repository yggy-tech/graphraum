import type { ClusterTree } from "./cluster-tree";
import { type CutElements, clusterKey, nodeKey, type Vec3 } from "./lod-transition";

/** Default time the layer takes to move from one tree to the next, in milliseconds. */
export const DEFAULT_UPDATE_MS = 600;

/** How many members of a new cluster vote for the drawn element it grew out of. */
const VOTERS = 48;

/** One drawn element on its way from where it was drawn to where the new tree puts it. */
export interface MorphTrack {
	/** Id of the element in the graph. */
	id: string;
	from: Vec3;
	/** Size at the start, as a share of the element's resting size. */
	fromScale: number;
	to: Vec3;
	/** Size at the end: 1 for an element that stays, a small share for one that shrinks away. */
	toScale: number;
}

/**
 * The key of the element (`c<cluster>` or `n<node>`) that drew node `index` under `tree` and the cut
 * `committed`, or null for a node that tree did not have. Nodes are appended, so an index means the
 * same node in both trees.
 */
export function drawnElementOf(tree: ClusterTree, committed: CutElements, index: number): string | null {
	if (index >= tree.nodeCount) return null;
	if (committed.nodes.has(index)) return nodeKey(index);
	let cluster = tree.leafOf[index] as number;
	while (cluster >= 0 && !committed.clusters.has(cluster)) cluster = tree.parent[cluster] as number;
	return cluster >= 0 ? clusterKey(cluster) : null;
}

/**
 * The element most of `members` were drawn in before, or null when none of them was drawn. Votes
 * with an even sample of the members, so large clusters cost the same as small ones.
 */
export function voteDrawnElement(
	members: ArrayLike<number>,
	elementOf: (index: number) => string | null,
): string | null {
	const step = Math.max(1, Math.floor(members.length / VOTERS));
	const votes = new Map<string, number>();
	let best: string | null = null;
	let bestVotes = 0;
	for (let position = 0; position < members.length; position += step) {
		const key = elementOf(members[position] as number);
		if (key === null) continue;
		const count = (votes.get(key) ?? 0) + 1;
		votes.set(key, count);
		if (count > bestVotes) {
			best = key;
			bestVotes = count;
		}
	}
	return best;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const mix = (from: number, to: number, t: number) => from + (to - from) * t;

/** Where `track` is and how large, at `progress` from 0 to 1. */
export function sampleMorph(track: MorphTrack, progress: number): { position: Vec3; scale: number } {
	const t = easeInOut(Math.min(Math.max(progress, 0), 1));
	return {
		position: {
			x: mix(track.from.x, track.to.x, t),
			y: mix(track.from.y, track.to.y, t),
			z: mix(track.from.z, track.to.z, t),
		},
		scale: mix(track.fromScale, track.toScale, t),
	};
}

/** True when the track starts where it ends, so it needs no frames. */
export function trackIsStill(track: MorphTrack): boolean {
	return (
		track.fromScale === track.toScale &&
		track.from.x === track.to.x &&
		track.from.y === track.to.y &&
		track.from.z === track.to.z
	);
}
