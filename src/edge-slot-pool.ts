import { DETAIL_MAX_SEGMENTS } from "./edge-paths";

/** Hands out runs of instance slots, so an edge that stays in view keeps the slots it was written to. */
export class EdgeSlotPool {
	/** Slots handed out so far, holes included: the instance count to draw. */
	extent = 0;
	/** Slots inside `extent` that no edge uses. */
	freeSlots = 0;
	private capacity = 0;
	/** Free runs by size, up to the longest edge path. */
	private readonly free: number[][] = Array.from({ length: DETAIL_MAX_SEGMENTS + 1 }, () => []);

	reset(extent: number, capacity: number) {
		this.extent = extent;
		this.capacity = capacity;
		this.freeSlots = 0;
		for (const runs of this.free) runs.length = 0;
	}

	/** The first slot of a run of `size` slots, or -1 when the run does not fit the capacity. */
	take(size: number): number {
		const start = this.free[size]?.pop();
		if (start !== undefined) {
			this.freeSlots -= size;
			return start;
		}
		if (this.extent + size > this.capacity) return -1;
		this.extent += size;
		return this.extent - size;
	}

	release(start: number, size: number) {
		this.free[size]?.push(start);
		this.freeSlots += size;
	}
}

/**
 * Counts, per edge, how many of its ends are on a drawn node, so a camera move that adds and
 * removes a few nodes names the few edges that enter or leave without scanning the rest.
 */
export class EdgeVisibility {
	/** False until `reset` counts the drawn nodes, and after any change that moved them unseen. */
	live = false;
	private ends = new Uint8Array(0);

	reset(nodeIndices: readonly number[], incidentEdgeIndices: readonly (readonly number[])[], edgeCount: number) {
		this.ends = new Uint8Array(edgeCount);
		this.live = true;
		this.shift(nodeIndices, 1, incidentEdgeIndices);
	}

	/**
	 * Moves every end of `nodes` by `step` and returns the edges whose count reached 1 going up (enter) or
	 * 0 going down (leave). Entering nodes go first, so an edge between a leaving and an entering node stays.
	 */
	shift(nodes: readonly number[], step: 1 | -1, incidentEdgeIndices: readonly (readonly number[])[]) {
		const reached: number[] = [];
		for (const node of nodes) {
			for (const edge of incidentEdgeIndices[node] ?? []) {
				this.ends[edge] = (this.ends[edge] ?? 0) + step;
				if (this.ends[edge] === (step > 0 ? 1 : 0)) reached.push(edge);
			}
		}
		return reached;
	}
}
