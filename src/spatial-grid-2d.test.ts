import { describe, expect, test } from "vitest";

import { SpatialGrid2D } from "./spatial-grid-2d";
import type { GraphraumNodeGeometry } from "./types";

describe("SpatialGrid2D", () => {
	test("picks the nearest overlapping node across cell boundaries", () => {
		const grid = new SpatialGrid2D(10);
		grid.set(0, { id: "left", position: { x: 9, y: 5 }, size: 3 });
		grid.set(1, { id: "right", position: { x: 11, y: 5 }, size: 3 });
		expect(grid.pick(10.75, 5)).toBe(1);
		expect(grid.pick(30, 30)).toBeNull();
	});

	test("respects the visible boundary of each built-in shape", () => {
		const grid = new SpatialGrid2D(10);
		grid.set(0, { id: "circle", position: { x: 0, y: 0 }, shape: "circle", size: 5 });
		grid.set(1, { id: "square", position: { x: 20, y: 0 }, shape: "square", size: 5 });
		grid.set(2, { id: "diamond", position: { x: 40, y: 0 }, shape: "diamond", size: 5 });

		expect(grid.pick(4, 4)).toBeNull();
		expect(grid.pick(24, 4)).toBe(1);
		expect(grid.pick(44, 4)).toBeNull();
		expect(grid.pick(42, 2)).toBe(2);
	});

	test("moves nodes without leaving stale memberships", () => {
		const grid = new SpatialGrid2D(10);
		grid.set(4, { id: "moving", position: { x: 1, y: 1 }, size: 2 });
		grid.set(4, { id: "moving", position: { x: 101, y: 101 }, size: 2 });
		expect(grid.pick(1, 1)).toBeNull();
		expect(grid.pick(101, 101)).toBe(4);
	});

	test("queries visible nodes with overscan", () => {
		const grid = new SpatialGrid2D(10);
		grid.set(0, { id: "visible", position: { x: 5, y: 5 }, size: 1 });
		grid.set(1, { id: "overscan", position: { x: 14, y: 5 }, size: 1 });
		grid.set(2, { id: "hidden", position: { x: 30, y: 5 }, size: 1 });
		grid.set(3, { id: "intersecting", position: { x: 20, y: 5 }, size: 11 });
		expect(grid.queryBounds({ bottom: 0, left: 0, right: 10, top: 10 }, 5)).toEqual([0, 1, 3]);
	});

	test("scans occupied cells instead of an enormous zoomed-out grid", () => {
		const grid = new SpatialGrid2D();
		grid.set(0, { id: "left", position: { x: -10, y: -10 }, size: 1 });
		grid.set(1, { id: "right", position: { x: 10, y: 10 }, size: 1 });

		expect(grid.queryBounds({ bottom: -1e12, left: -1e12, right: 1e12, top: 1e12 })).toEqual([0, 1]);
	});

	test("normalizes picking by independent width and height, not a single radius", () => {
		const grid = new SpatialGrid2D(20);
		grid.set(0, { id: "wide", position: { x: 0, y: 0 }, shape: "square", width: 10, height: 2 });

		// Within the wide axis but outside the narrow one.
		expect(grid.pick(8, 0)).toBe(0);
		expect(grid.pick(0, 4)).toBeNull();
		// Within the narrow axis but outside the wide one.
		expect(grid.pick(0, 1)).toBe(0);
		expect(grid.pick(12, 0)).toBeNull();
	});

	test("widens occupancy by strokeWidth for cell bucketing and bounding-box queries", () => {
		const grid = new SpatialGrid2D(10);
		grid.set(0, { id: "stroked", position: { x: 20, y: 5 }, size: 5, strokeWidth: 4 });

		// size 5 alone would not reach a query bound ending at 14; the stroke padding closes the gap.
		expect(grid.queryBounds({ bottom: 0, left: 0, right: 14, top: 10 })).toEqual([0]);
	});

	test("matches a brute-force scan through random moves, outliers and queries", () => {
		let seed = 12345;
		const random = () => {
			seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
			return seed / 2 ** 32;
		};
		const grid = new SpatialGrid2D(16);
		const nodes: GraphraumNodeGeometry[] = [];
		const place = (index: number) => {
			const outlier = random() < 0.02;
			const node = {
				id: `n${index}`,
				position: { x: (random() - 0.5) * (outlier ? 1e7 : 500), y: (random() - 0.5) * (outlier ? 1e7 : 500) },
				size: 0.5 + random() * 6,
			};
			nodes[index] = node;
			grid.set(index, node);
		};
		for (let index = 0; index < 420; index += 1) place(index);
		for (let round = 0; round < 60; round += 1) {
			for (let move = 0; move < 5; move += 1) place(Math.floor(random() * 420));
			const left = (random() - 0.5) * 700;
			const bottom = (random() - 0.5) * 700;
			const bounds = { bottom, left, right: left + random() * 300, top: bottom + random() * 300 };
			const expected = nodes
				.flatMap((node, index) => {
					const radius = node.size ?? 0;
					const inside =
						node.position.x + radius >= bounds.left - 4 &&
						node.position.x - radius <= bounds.right + 4 &&
						node.position.y + radius >= bounds.bottom - 4 &&
						node.position.y - radius <= bounds.top + 4;
					return inside ? [index] : [];
				})
				.sort((a, b) => a - b);
			expect([...grid.queryBounds(bounds, 4)].sort((a, b) => a - b)).toEqual(expected);
			const target = nodes[Math.floor(random() * nodes.length)] as GraphraumNodeGeometry;
			expect(grid.pick(target.position.x, target.position.y)).not.toBeNull();
		}
	});

	test("coarsens the cells for a huge extent instead of allocating a cell per 32 units", () => {
		const grid = new SpatialGrid2D();
		grid.set(0, { id: "a", position: { x: -1e9, y: -1e9 }, size: 1 });
		grid.set(1, { id: "b", position: { x: 1e9, y: 1e9 }, size: 1 });
		expect(grid.queryBounds({ bottom: 0, left: 0, right: 1e10, top: 1e10 })).toEqual([1]);
		expect(grid.pick(-1e9, -1e9)).toBe(0);
	});
});
