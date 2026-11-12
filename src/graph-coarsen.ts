/**
 * Graph coarsening for the multilevel layout: heavy-edge matching plus leaf merging, on compressed
 * adjacency in typed arrays. O(n + m) per level, deterministic for a seed. Pure and free of layout
 * code, so other level-of-detail code can reuse it.
 */

/** One graph level in compressed adjacency form: each undirected edge appears in both endpoint rows. */
export interface CoarseLevel {
	/** Neighbour ids. Self loops are dropped; parallel edges are merged from the second level on. */
	col: Uint32Array;
	/** Optional group id per node, dense from 0 (nodes of different groups are never merged). */
	groups: Uint32Array | null;
	nodeCount: number;
	/** Number of level-0 nodes each node stands for. */
	nodeWeight: Float32Array;
	/** The node of this level that each node of the finer level was merged into. Absent on level 0. */
	parent: Uint32Array | null;
	rowPtr: Uint32Array;
	/** Summed weight of the merged edges, parallel to `col`. */
	weight: Float32Array;
}

function hash32(seed: number) {
	let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
	value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
	return (value ^ (value >>> 16)) >>> 0;
}

/** Renumbers group ids to 0..k-1 in order of first use. */
function compactGroups(groups: Uint32Array): Uint32Array {
	const ids = new Map<number, number>();
	return Uint32Array.from(groups, (group) => {
		let id = ids.get(group);
		if (id === undefined) {
			id = ids.size;
			ids.set(group, id);
		}
		return id;
	});
}

/** The finest level of an edge list. Edges with an endpoint at or past `nodeCount` and self loops are dropped; parallel edges stay until the first contraction merges them. */
export function baseCoarseLevel(nodeCount: number, edges: Uint32Array, groups?: Uint32Array): CoarseLevel {
	const rowPtr = new Uint32Array(nodeCount + 1);
	for (let index = 0; index < edges.length; index += 2) {
		const source = edges[index] ?? 0;
		const target = edges[index + 1] ?? 0;
		if (source === target || source >= nodeCount || target >= nodeCount) continue;
		rowPtr[source + 1] += 1;
		rowPtr[target + 1] += 1;
	}
	for (let node = 0; node < nodeCount; node += 1) rowPtr[node + 1] += rowPtr[node] ?? 0;
	const cursor = rowPtr.slice(0, nodeCount);
	const col = new Uint32Array(rowPtr[nodeCount] ?? 0);
	for (let index = 0; index < edges.length; index += 2) {
		const source = edges[index] ?? 0;
		const target = edges[index + 1] ?? 0;
		if (source === target || source >= nodeCount || target >= nodeCount) continue;
		col[cursor[source]++] = target;
		col[cursor[target]++] = source;
	}
	return {
		col,
		groups: groups ? compactGroups(groups) : null,
		nodeCount,
		nodeWeight: new Float32Array(nodeCount).fill(1),
		parent: null,
		rowPtr,
		weight: new Float32Array(col.length).fill(1),
	};
}

/**
 * Assigns every node a coarse id: heavy-edge matching in a seeded random order (the edge weight over the
 * combined node weight, so groups stay balanced), then degree-1 nodes that found no partner join their
 * neighbour's group, which lets a hub swallow its leaves in one level. Returns the ids and their count.
 */
function matchNodes(level: CoarseLevel, seed: number) {
	const { col, groups, nodeCount, nodeWeight, rowPtr, weight } = level;
	const parent = new Uint32Array(nodeCount).fill(0xffff_ffff);
	const order = new Uint32Array(nodeCount);
	for (let node = 0; node < nodeCount; node += 1) order[node] = node;
	for (let index = nodeCount - 1; index > 0; index -= 1) {
		const swap = hash32(index * 0x27d4eb2d + seed) % (index + 1);
		const held = order[index] ?? 0;
		order[index] = order[swap] ?? 0;
		order[swap] = held;
	}
	let count = 0;
	for (const node of order) {
		if (parent[node] !== 0xffff_ffff) continue;
		let best = -1;
		let bestScore = 0;
		for (let cursor = rowPtr[node] ?? 0; cursor < (rowPtr[node + 1] ?? 0); cursor += 1) {
			const neighbour = col[cursor] ?? 0;
			if (parent[neighbour] !== 0xffff_ffff) continue;
			if (groups && groups[neighbour] !== groups[node]) continue;
			const score = (weight[cursor] ?? 0) / ((nodeWeight[node] ?? 1) + (nodeWeight[neighbour] ?? 1));
			if (score > bestScore) {
				bestScore = score;
				best = neighbour;
			}
		}
		parent[node] = count;
		if (best >= 0) parent[best] = count;
		count += 1;
	}
	return { count, parent };
}

/**
 * Leaf merging needs the pass after matching, so it lives apart: a leaf whose only neighbour already
 * has a group is folded in. Returns the ids renumbered densely.
 */
function foldLeaves(level: CoarseLevel, matched: { count: number; parent: Uint32Array }) {
	const { col, groups, nodeCount, rowPtr } = level;
	const { count, parent } = matched;
	const size = new Uint32Array(count);
	for (const group of parent) size[group] += 1;
	const keep = new Uint8Array(count).fill(1);
	// A singleton group with exactly one neighbour is a leaf: it joins that neighbour's group.
	const folded = parent.slice();
	for (let node = 0; node < nodeCount; node += 1) {
		const group = parent[node] ?? 0;
		if ((size[group] ?? 0) !== 1) continue;
		if ((rowPtr[node + 1] ?? 0) - (rowPtr[node] ?? 0) !== 1) continue;
		const neighbour = col[rowPtr[node] ?? 0] ?? 0;
		if (groups && groups[neighbour] !== groups[node]) continue;
		const target = folded[neighbour] ?? 0;
		folded[node] = target;
		keep[group] = 0;
	}
	const renumber = new Uint32Array(count);
	let next = 0;
	for (let group = 0; group < count; group += 1) if (keep[group]) renumber[group] = next++;
	for (let node = 0; node < nodeCount; node += 1) folded[node] = renumber[folded[node] ?? 0] ?? 0;
	return { count: next, parent: folded };
}

/** Contracts `level` by `parent` into a level with `count` nodes. */
function contract(level: CoarseLevel, parent: Uint32Array, count: number): CoarseLevel {
	const { col, nodeCount, nodeWeight, rowPtr, weight } = level;
	const memberStart = new Uint32Array(count + 1);
	for (const group of parent) memberStart[group + 1] += 1;
	for (let group = 0; group < count; group += 1) memberStart[group + 1] += memberStart[group] ?? 0;
	const fill = memberStart.slice(0, count);
	const members = new Uint32Array(nodeCount);
	for (let node = 0; node < nodeCount; node += 1) members[fill[parent[node] ?? 0]++] = node;
	const nextCol = new Uint32Array(col.length);
	const nextWeight = new Float32Array(col.length);
	const nextPtr = new Uint32Array(count + 1);
	const nextNodeWeight = new Float32Array(count);
	const nextGroups = level.groups ? new Uint32Array(count) : null;
	const slot = new Int32Array(count).fill(-1);
	let write = 0;
	for (let group = 0; group < count; group += 1) {
		const rowStart = write;
		for (let index = memberStart[group] ?? 0; index < (memberStart[group + 1] ?? 0); index += 1) {
			const node = members[index] ?? 0;
			nextNodeWeight[group] += nodeWeight[node] ?? 0;
			if (nextGroups && level.groups) nextGroups[group] = level.groups[node] ?? 0;
			for (let cursor = rowPtr[node] ?? 0; cursor < (rowPtr[node + 1] ?? 0); cursor += 1) {
				const target = parent[col[cursor] ?? 0] ?? 0;
				if (target === group) continue;
				const at = slot[target] ?? -1;
				if (at >= rowStart) nextWeight[at] += weight[cursor] ?? 0;
				else {
					slot[target] = write;
					nextCol[write] = target;
					nextWeight[write] = weight[cursor] ?? 0;
					write += 1;
				}
			}
		}
		nextPtr[group + 1] = write;
	}
	return {
		col: nextCol.slice(0, write),
		groups: nextGroups,
		nodeCount: count,
		nodeWeight: nextNodeWeight,
		parent,
		rowPtr: nextPtr,
		weight: nextWeight.slice(0, write),
	};
}

/** The next coarser level of `level`. Its `parent` maps the nodes of `level` to the new ids. */
export function coarsenLevel(level: CoarseLevel, seed = 0): CoarseLevel {
	const { count, parent } = foldLeaves(level, matchNodes(level, seed));
	return contract(level, parent, count);
}

export interface CoarsenOptions {
	/** Stop once a level has at most this many nodes. */
	coarsestSize: number;
	/** Most levels to add on top of the finest one. */
	maxLevels: number;
	seed?: number;
}

/** Below this share of nodes removed a level is not worth keeping, and coarsening stops. */
const MIN_REDUCTION = 0.1;

/** All levels, finest first. Always contains at least the finest level. */
export function coarsenGraph(finest: CoarseLevel, options: CoarsenOptions): CoarseLevel[] {
	const levels = [finest];
	for (let depth = 0; depth < options.maxLevels; depth += 1) {
		const top = levels[levels.length - 1] as CoarseLevel;
		if (top.nodeCount <= options.coarsestSize) break;
		const next = coarsenLevel(top, (options.seed ?? 0) + depth * 0x9e37);
		if (next.nodeCount > top.nodeCount * (1 - MIN_REDUCTION)) break;
		levels.push(next);
	}
	return levels;
}

/** Upper-triangle edge list (`source < target`) of a level, for the force layout. */
export function levelEdges(level: CoarseLevel): { edges: Uint32Array; weights: Float32Array } {
	let count = 0;
	for (let node = 0; node < level.nodeCount; node += 1) {
		for (let cursor = level.rowPtr[node] ?? 0; cursor < (level.rowPtr[node + 1] ?? 0); cursor += 1) {
			if ((level.col[cursor] ?? 0) > node) count += 1;
		}
	}
	const edges = new Uint32Array(count * 2);
	const weights = new Float32Array(count);
	let write = 0;
	for (let node = 0; node < level.nodeCount; node += 1) {
		for (let cursor = level.rowPtr[node] ?? 0; cursor < (level.rowPtr[node + 1] ?? 0); cursor += 1) {
			const target = level.col[cursor] ?? 0;
			if (target <= node) continue;
			edges[write * 2] = node;
			edges[write * 2 + 1] = target;
			weights[write] = level.weight[cursor] ?? 1;
			write += 1;
		}
	}
	return { edges, weights };
}
