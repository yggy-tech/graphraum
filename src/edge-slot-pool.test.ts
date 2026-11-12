import { describe, expect, test } from "vitest";

import { EdgeSlotPool, EdgeVisibility } from "./edge-slot-pool";

describe("EdgeSlotPool", () => {
	test("hands out fresh runs, then reuses released ones", () => {
		const pool = new EdgeSlotPool();
		pool.reset(0, 100);
		expect([pool.take(2), pool.take(1), pool.take(3)]).toEqual([0, 2, 3]);
		pool.release(0, 2);
		expect(pool.freeSlots).toBe(2);
		expect(pool.take(2)).toBe(0);
		expect(pool.freeSlots).toBe(0);
		expect(pool.extent).toBe(6);
	});

	test("reports a run that does not fit the capacity", () => {
		const pool = new EdgeSlotPool();
		pool.reset(8, 10);
		expect(pool.take(3)).toBe(-1);
		expect(pool.take(2)).toBe(8);
	});
});

describe("EdgeVisibility", () => {
	// Edge 0: nodes 0-1, edge 1: nodes 1-2, edge 2: node 2 to itself.
	const incident = [[0], [0, 1], [1, 2, 2]];

	test("names the edges that gain their first or lose their last drawn end", () => {
		const visibility = new EdgeVisibility();
		visibility.reset([0], incident, 3);
		const move = (entering: number[], leaving: number[]) => ({
			entered: visibility.shift(entering, 1, incident),
			left: visibility.shift(leaving, -1, incident),
		});
		expect(move([1], [0])).toEqual({ entered: [1], left: [] });
		expect(move([2], [1])).toEqual({ entered: [2], left: [0] });
		expect(move([], [2])).toEqual({ entered: [], left: [1, 2] });
	});
});
