import { describe, expect, test } from "vitest";

import {
	applyEdgeBudget,
	collectIncidentEdges,
	dropSubPixelEdges,
	endpointDegreeScore,
	resolveLodLevel,
	shouldUseDensityLod,
} from "./viewport-lod";

describe("viewport LOD", () => {
	test("resolves the diagnostics/edge LOD tier from density and edge budget state", () => {
		expect(resolveLodLevel(true, 10, 5)).toBe("density");
		expect(resolveLodLevel(false, 10, 5)).toBe("overview");
		expect(resolveLodLevel(false, 5, 5)).toBe("detail");
	});

	test("uses hysteresis around the visible-node budget", () => {
		expect(shouldUseDensityLod(110, 100, false)).toBe(false);
		expect(shouldUseDensityLod(111, 100, false)).toBe(true);
		expect(shouldUseDensityLod(86, 100, true)).toBe(true);
		expect(shouldUseDensityLod(85, 100, true)).toBe(false);
	});

	test("collects unique incident edges without a full edge scan", () => {
		expect(
			collectIncidentEdges(
				[0, 2],
				[
					[0, 1],
					[1, 2],
					[2, 3],
				],
			),
		).toEqual([0, 1, 2, 3]);
	});

	test("keeps detail edges or applies an evenly distributed overview budget", () => {
		expect(applyEdgeBudget([2, 4], 3)).toEqual([2, 4]);
		expect(applyEdgeBudget([0, 1, 2, 3, 4, 5], 3)).toEqual([0, 2, 4]);
		expect(() => applyEdgeBudget([1], 0)).toThrow("positive integer");
	});

	describe("importance budget", () => {
		const edgeCount = 1000;
		const all = Array.from({ length: edgeCount }, (_, index) => index);
		// Edge i has score 0..9, so each score owns a tenth of the edges.
		const score = (edgeIndex: number) => edgeIndex % 10;

		test("keeps the highest scores first and is exact at the budget", () => {
			const kept = applyEdgeBudget(all, 300, { score });
			expect(kept).toHaveLength(300);
			expect(kept.every((edgeIndex) => score(edgeIndex) >= 7)).toBe(true);
			expect(applyEdgeBudget(all, 100, { score }).every((edgeIndex) => score(edgeIndex) === 9)).toBe(true);
			expect(applyEdgeBudget(all, 150, { score }).filter((edgeIndex) => score(edgeIndex) === 9)).toHaveLength(100);
		});

		test("spreads ties over the index range instead of taking the first ones", () => {
			const kept = applyEdgeBudget(all, 50, { score: () => 1 });
			expect(kept).toHaveLength(50);
			expect(Math.max(...kept)).toBeGreaterThan(edgeCount / 2);
		});

		test("pins edges ahead of better scores and caps pins at the budget", () => {
			const pinned = new Set([0, 10, 20]);
			const kept = applyEdgeBudget(all, 100, { pinned, score });
			expect(kept).toHaveLength(100);
			for (const edgeIndex of pinned) expect(kept).toContain(edgeIndex);
			const many = new Set(Array.from({ length: 40 }, (_, index) => index));
			expect(applyEdgeBudget(all, 10, { pinned: many, score })).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		});

		test("is deterministic and keeps the same edges while the candidate list shifts", () => {
			expect(applyEdgeBudget(all, 200, { score })).toEqual(applyEdgeBudget(all, 200, { score }));
			const first = new Set(applyEdgeBudget(all.slice(0, 900), 200, { score }));
			const second = applyEdgeBudget(all.slice(100), 200, { score });
			const overlap = second.filter((edgeIndex) => edgeIndex < 900);
			const shared = overlap.filter((edgeIndex) => first.has(edgeIndex)).length;
			expect(shared / overlap.length).toBeGreaterThan(0.9);
		});

		test("scores an edge by the degree of both endpoints", () => {
			const incident = [[0, 1, 2], [0], [1, 2]];
			const degree = endpointDegreeScore(new Uint32Array([0, 1, 0, 2]), incident);
			expect(degree(0)).toBe(4);
			expect(degree(1)).toBe(5);
		});
	});

	test("drops edges shorter than the pixel threshold unless pinned", () => {
		// Edge 0 is 0.4 long, edge 1 is 10, edge 2 is 0.4 and pinned. One world unit is one pixel.
		const positions = new Float32Array([0, 0, 0, 0.4, 0, 0, 0, 0, 0, 10, 0, 0, 5, 5, 0, 5, 5.4, 0]);
		expect(dropSubPixelEdges([0, 1, 2], positions, 1, 0.75, new Set([2]))).toEqual({ kept: [1, 2], skipped: 1 });
		expect(dropSubPixelEdges([0, 1, 2], positions, 0.1, 0.75)).toEqual({ kept: [0, 1, 2], skipped: 0 });
	});
});
