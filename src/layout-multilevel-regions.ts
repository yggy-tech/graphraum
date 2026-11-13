/**
 * Parallel refinement of one multilevel level: the nodes are split into spatial regions, each region is
 * refined by one worker that moves only its own nodes, and the workers exchange positions every couple
 * of steps. Every worker draws the same repulsion samples as a single thread would (same node ids, same
 * seeds, over all nodes), and the nodes it does not own sit at their last exchanged position, so a
 * node's force matches the single thread result closely and the push does not grow the way it would
 * with samples drawn only inside a region.
 */

import type { ForceAnchors, ForceLayoutRequest } from "./force-layout";

/** The part of a worker the region refinement uses; a DOM `Worker` fits. */
export interface RegionWorker {
	onerror: ((event: { message?: string }) => void) | null;
	onmessage: ((event: { data: RegionReply }) => void) | null;
	postMessage(message: RegionRequest, transfer?: Transferable[]): void;
	terminate(): void;
}

/** Starts a region's simulation. `edges` and the per-edge arrays hold only the edges that touch `owned`. */
export interface RegionInit {
	anchors?: ForceAnchors;
	clusters?: Uint32Array;
	dimensions: 2 | 3;
	edges: Uint32Array;
	linkDistances?: Float32Array;
	nodeCount: number;
	owned: Uint32Array;
	settings?: ForceLayoutRequest["settings"];
	/** Positions of all nodes, shared by every region when `shared` is set. */
	start: Float32Array;
	springStrengths?: Float32Array;
	type: "init";
	/** Set when the exchange goes through shared memory: the regions read and write this array. */
	shared?: boolean;
}

/**
 * Runs the steps of one round. `sync` says where the other regions' positions come from: `"none"` (the
 * first round, they are the start), `"snapshot"` (sent along) or `"shared"` (read from the shared array).
 */
export interface RegionRound {
	alphas: number[];
	snapshot?: Float32Array;
	sync: "none" | "shared" | "snapshot";
	type: "round";
}

/** Shared-memory exchange only: write the owned positions into the shared array. */
export interface RegionPublish {
	type: "publish";
}

export type RegionRequest = RegionInit | RegionPublish | RegionRound;

export type RegionReply =
	| { message: string; type: "error" }
	| { type: "published" }
	| { type: "ready" }
	| { positions?: Float32Array; type: "rounded" };

/** What one level asks of the refinement: the simulation to run and the schedule. */
export interface RegionJob {
	/** Force steps' alphas, in order. */
	alphas: number[];
	/** Extra cost of each node in the split: its edge-t draws. */
	nodeWeights: Float32Array;
	/** The level as a force layout request, started at the prolonged positions with `warmStart`. */
	request: ForceLayoutRequest & { initialPositions: Float32Array };
}

/** Steps between two exchanges of positions. */
export const REGION_SYNC_STEPS = 2;
/** The fewest nodes a region is worth a worker for. */
export const MIN_REGION_NODES = 5_000;
const HISTOGRAM_BINS = 1_024;

/** Regions a level of `nodeCount` nodes is split into, at most `workers`. */
export function regionCountFor(nodeCount: number, workers: number) {
	return Math.max(1, Math.min(workers, Math.floor(nodeCount / MIN_REGION_NODES)));
}

/**
 * Splits the nodes into `regions` spatial regions of about equal cost by cutting at the weighted median
 * of the widest axis, recursively (a k-d split with histograms, so no sorting). Returns the region of
 * every node. Deterministic.
 */
export function partitionRegions(
	positions: Float32Array,
	weights: Float32Array,
	dimensions: 2 | 3,
	regions: number,
): Uint8Array {
	const nodeCount = positions.length / 3;
	const owner = new Uint8Array(nodeCount);
	if (regions <= 1) return owner;
	const ids = new Uint32Array(nodeCount);
	for (let node = 0; node < nodeCount; node += 1) ids[node] = node;
	const scratch = new Uint32Array(nodeCount);
	const bins = new Float64Array(HISTOGRAM_BINS);

	const split = (from: number, to: number, firstRegion: number, count: number) => {
		if (count === 1) {
			for (let slot = from; slot < to; slot += 1) owner[ids[slot] ?? 0] = firstRegion;
			return;
		}
		let axis = 0;
		let low = 0;
		let high = 0;
		let widest = -1;
		for (let candidate = 0; candidate < dimensions; candidate += 1) {
			let min = Number.POSITIVE_INFINITY;
			let max = Number.NEGATIVE_INFINITY;
			for (let slot = from; slot < to; slot += 1) {
				const value = positions[(ids[slot] ?? 0) * 3 + candidate] ?? 0;
				if (value < min) min = value;
				if (value > max) max = value;
			}
			if (max - min > widest) {
				widest = max - min;
				axis = candidate;
				low = min;
				high = max;
			}
		}
		const leftRegions = Math.floor(count / 2);
		bins.fill(0);
		let total = 0;
		const binScale = high > low ? HISTOGRAM_BINS / (high - low) : 0;
		const binOf = (node: number) =>
			Math.min(HISTOGRAM_BINS - 1, Math.floor(((positions[node * 3 + axis] ?? 0) - low) * binScale));
		for (let slot = from; slot < to; slot += 1) {
			const node = ids[slot] ?? 0;
			bins[binOf(node)] += weights[node] ?? 1;
			total += weights[node] ?? 1;
		}
		const wanted = (total * leftRegions) / count;
		let cut = 0;
		let below = 0;
		while (cut < HISTOGRAM_BINS - 1 && below + (bins[cut] ?? 0) <= wanted) {
			below += bins[cut] ?? 0;
			cut += 1;
		}
		// Bins below the cut go left; the cut bin is shared out in id order until the left side is full.
		let left = 0;
		let right = 0;
		let leftWeight = below;
		for (let slot = from; slot < to; slot += 1) {
			const node = ids[slot] ?? 0;
			const bin = binOf(node);
			let goesLeft = bin < cut;
			if (bin === cut && leftWeight < wanted) {
				goesLeft = true;
				leftWeight += weights[node] ?? 1;
			}
			if (goesLeft) ids[from + left++] = node;
			else scratch[right++] = node;
		}
		scratch.subarray(0, right).forEach((node, offset) => {
			ids[from + left + offset] = node;
		});
		split(from, from + left, firstRegion, leftRegions);
		split(from + left, to, firstRegion + leftRegions, count - leftRegions);
	};
	split(0, nodeCount, 0, regions);
	return owner;
}

/** One region's share of a job: its nodes and the edges that touch them. */
interface RegionShare {
	edges: Uint32Array;
	linkDistances?: Float32Array;
	owned: Uint32Array;
	springStrengths?: Float32Array;
}

/**
 * Lists each region's nodes (ascending) and its edges: an edge between two regions goes to both, since
 * each moves its own end. Two passes over the edges, no per-edge objects.
 */
export function shareOutRegions(job: RegionJob, owner: Uint8Array, regions: number): RegionShare[] {
	const { edges, linkDistances, nodeCount, springStrengths } = job.request;
	const nodeTotals = new Uint32Array(regions);
	for (let node = 0; node < nodeCount; node += 1) nodeTotals[owner[node] ?? 0] += 1;
	const edgeTotals = new Uint32Array(regions);
	for (let index = 0; index < edges.length; index += 2) {
		const source = owner[edges[index] ?? 0] ?? 0;
		const target = owner[edges[index + 1] ?? 0] ?? 0;
		edgeTotals[source] += 1;
		if (target !== source) edgeTotals[target] += 1;
	}
	const shares: RegionShare[] = Array.from({ length: regions }, (_, region) => ({
		edges: new Uint32Array((edgeTotals[region] ?? 0) * 2),
		...(linkDistances ? { linkDistances: new Float32Array(edgeTotals[region] ?? 0) } : {}),
		owned: new Uint32Array(nodeTotals[region] ?? 0),
		...(springStrengths ? { springStrengths: new Float32Array(edgeTotals[region] ?? 0) } : {}),
	}));
	const nodeCursor = new Uint32Array(regions);
	for (let node = 0; node < nodeCount; node += 1) {
		const region = owner[node] ?? 0;
		(shares[region] as RegionShare).owned[nodeCursor[region]++] = node;
	}
	const edgeCursor = new Uint32Array(regions);
	const add = (region: number, index: number) => {
		const share = shares[region] as RegionShare;
		const slot = edgeCursor[region]++;
		share.edges[slot * 2] = edges[index] ?? 0;
		share.edges[slot * 2 + 1] = edges[index + 1] ?? 0;
		if (share.linkDistances && linkDistances) share.linkDistances[slot] = linkDistances[index / 2] ?? 0;
		if (share.springStrengths && springStrengths) share.springStrengths[slot] = springStrengths[index / 2] ?? 0;
	};
	for (let index = 0; index < edges.length; index += 2) {
		const source = owner[edges[index] ?? 0] ?? 0;
		const target = owner[edges[index + 1] ?? 0] ?? 0;
		add(source, index);
		if (target !== source) add(target, index);
	}
	return shares;
}

/** Workers that outlive one level, so the spawn cost is paid once per layout. */
export class RegionPool {
	readonly size: number;
	private readonly pending: { reject: (error: Error) => void; resolve: (reply: RegionReply) => void }[][];
	private readonly workers: RegionWorker[];

	constructor(createWorker: () => RegionWorker, size: number) {
		this.size = size;
		this.workers = [];
		this.pending = [];
		try {
			for (let index = 0; index < size; index += 1) this.workers.push(createWorker());
		} catch (error) {
			this.dispose();
			throw error;
		}
		for (const [index, worker] of this.workers.entries()) {
			const queue: RegionPool["pending"][number] = [];
			this.pending.push(queue);
			worker.onmessage = ({ data }) => {
				const next = queue.shift();
				if (data.type === "error") next?.reject(new Error(data.message));
				else next?.resolve(data);
			};
			worker.onerror = (event) => {
				const error = new Error(event.message ?? `Region worker ${index} failed.`);
				for (const waiting of queue.splice(0)) waiting.reject(error);
			};
		}
	}

	call(index: number, message: RegionRequest, transfer: Transferable[] = []): Promise<RegionReply> {
		return new Promise((resolve, reject) => {
			(this.pending[index] as RegionPool["pending"][number]).push({ reject, resolve });
			(this.workers[index] as RegionWorker).postMessage(message, transfer);
		});
	}

	dispose() {
		for (const worker of this.workers) worker.terminate();
		this.workers.length = 0;
	}
}

export interface RegionRefineOptions {
	/** Share positions through a `SharedArrayBuffer` instead of posting them every round. */
	shared: boolean;
	/** Steps between two exchanges. Omitted: {@link REGION_SYNC_STEPS}. */
	syncSteps?: number;
}

/** Subtracts the mean position, like the end of every single-thread step. */
function recenter(positions: Float32Array, dimensions: 2 | 3) {
	const nodeCount = positions.length / 3;
	const sums = [0, 0, 0];
	for (let node = 0; node < nodeCount; node += 1) {
		for (let axis = 0; axis < dimensions; axis += 1) sums[axis] += positions[node * 3 + axis] ?? 0;
	}
	for (let axis = 0; axis < dimensions; axis += 1) sums[axis] = (sums[axis] ?? 0) / Math.max(1, nodeCount);
	for (let node = 0; node < nodeCount; node += 1) {
		for (let axis = 0; axis < dimensions; axis += 1) positions[node * 3 + axis] -= sums[axis] ?? 0;
	}
}

function expectReply<Type extends RegionReply["type"]>(reply: RegionReply, type: Type) {
	if (reply.type !== type) throw new Error(`Region worker answered ${reply.type}, expected ${type}.`);
	return reply as Extract<RegionReply, { type: Type }>;
}

/**
 * Refines a level with `regions` workers of the pool (at most its size) and returns the positions of all
 * nodes. Rejects when a worker fails; the caller falls back to one thread.
 */
export async function refineInRegions(
	job: RegionJob,
	pool: RegionPool,
	regions: number,
	options: RegionRefineOptions,
): Promise<Float32Array> {
	const { request } = job;
	const { dimensions, nodeCount } = request;
	const owner = partitionRegions(request.initialPositions, job.nodeWeights, dimensions, regions);
	const shares = shareOutRegions(job, owner, regions);
	const positions = options.shared
		? new Float32Array(new SharedArrayBuffer(nodeCount * 3 * Float32Array.BYTES_PER_ELEMENT))
		: new Float32Array(nodeCount * 3);
	positions.set(request.initialPositions);

	const owners = Array.from({ length: regions }, (_, region) => region);
	const ownedByRegion = shares.map((share) => share.owned);
	await Promise.all(
		owners.map(async (region) => {
			const share = shares[region] as RegionShare;
			const init: RegionInit = {
				...(request.anchors ? { anchors: request.anchors } : {}),
				...(request.clusters ? { clusters: request.clusters } : {}),
				dimensions,
				edges: share.edges,
				...(share.linkDistances ? { linkDistances: share.linkDistances } : {}),
				nodeCount,
				owned: share.owned,
				settings: request.settings,
				...(options.shared ? { shared: true } : {}),
				start: options.shared ? positions : positions.slice(),
				...(share.springStrengths ? { springStrengths: share.springStrengths } : {}),
				type: "init",
			};
			// `owned` is copied, not transferred: this thread reads it to unpack the replies.
			const transfer: Transferable[] = [init.edges.buffer];
			if (init.linkDistances) transfer.push(init.linkDistances.buffer);
			if (init.springStrengths) transfer.push(init.springStrengths.buffer);
			if (!options.shared) transfer.push(init.start.buffer);
			expectReply(await pool.call(region, init, transfer), "ready");
		}),
	);

	const syncSteps = options.syncSteps ?? REGION_SYNC_STEPS;
	for (let first = 0; first < job.alphas.length; first += syncSteps) {
		const alphas = job.alphas.slice(first, first + syncSteps);
		const sync = first === 0 ? "none" : options.shared ? "shared" : "snapshot";
		if (options.shared) {
			await Promise.all(
				owners.map(async (region) => expectReply(await pool.call(region, { alphas, sync, type: "round" }), "rounded")),
			);
			await Promise.all(
				owners.map(async (region) => expectReply(await pool.call(region, { type: "publish" }), "published")),
			);
		} else {
			await Promise.all(
				owners.map(async (region) => {
					const message: RegionRound = {
						alphas,
						sync,
						type: "round",
						...(sync === "snapshot" ? { snapshot: positions } : {}),
					};
					const { positions: packed } = expectReply(await pool.call(region, message), "rounded");
					const owned = ownedByRegion[region] as Uint32Array;
					for (let slot = 0; slot < owned.length; slot += 1) {
						const node = (owned[slot] ?? 0) * 3;
						positions[node] = packed?.[slot * 3] ?? 0;
						positions[node + 1] = packed?.[slot * 3 + 1] ?? 0;
						positions[node + 2] = packed?.[slot * 3 + 2] ?? 0;
					}
				}),
			);
		}
		recenter(positions, dimensions);
	}
	// A shared array stays valid for the workers; the caller gets a private copy.
	return options.shared ? new Float32Array(positions) : positions;
}
