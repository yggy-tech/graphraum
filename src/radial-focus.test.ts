import { describe, expect, test } from "vitest";

import { crispEdgeIndices, crispNodeIndices, radialBlurRadius, vignetteShare, vignetteTone } from "./radial-focus";

describe("radialBlurRadius", () => {
	test("is sharp inside the inner radius and full from the outer radius on", () => {
		expect(radialBlurRadius(0, 100, 400, 20)).toBe(0);
		expect(radialBlurRadius(100, 100, 400, 20)).toBe(0);
		expect(radialBlurRadius(400, 100, 400, 20)).toBe(20);
		expect(radialBlurRadius(900, 100, 400, 20)).toBe(20);
	});

	test("grows smoothly and monotonically in between, with no step", () => {
		const radii = Array.from({ length: 31 }, (_, step) => radialBlurRadius(100 + step * 10, 100, 400, 20));
		for (const [index, radius] of radii.entries()) {
			if (index > 0) {
				expect(radius).toBeGreaterThanOrEqual(radii[index - 1] ?? 0);
				expect(radius - (radii[index - 1] ?? 0)).toBeLessThan(1);
			}
		}
		expect(radialBlurRadius(250, 100, 400, 20)).toBeCloseTo(10);
	});
});

describe("vignette", () => {
	test("is nothing in the middle and full in the corners", () => {
		expect(vignetteShare(0.5, 0.5)).toBe(0);
		expect(vignetteShare(0, 0)).toBe(1);
		expect(vignetteShare(1, 1)).toBe(1);
		expect(vignetteShare(0.5, 0.05)).toBeGreaterThan(0);
	});

	test("darkens a dark background and dims a light one toward its own tone", () => {
		const dark = vignetteTone("#0b0e14");
		const light = vignetteTone("#f4f5f7");
		expect(Math.max(...dark)).toBeLessThan(0.01);
		expect(Math.min(...light)).toBeGreaterThan(0.5);
		expect(vignetteTone(null)).toEqual([0, 0, 0]);
	});
});

describe("crisp sets", () => {
	// Edges: 0 = 0-1, 1 = 0-2, 2 = 1-2, 3 = 2-3.
	const edgeNodes = [0, 1, 0, 2, 1, 2, 2, 3];
	const incident = [[0, 1], [0, 2], [1, 2, 3], [3]];
	const incidentOf = (index: number) => incident[index] ?? [];
	const neighbours = (index: number) =>
		incidentOf(index).map(
			(edge) => (edgeNodes[edge * 2] === index ? edgeNodes[edge * 2 + 1] : edgeNodes[edge * 2]) ?? 0,
		);

	test("the anchors and their one-hop neighbours stay crisp", () => {
		expect([...crispNodeIndices([0], [0], neighbours)].sort()).toEqual([0, 1, 2]);
	});

	test("hovered anchors stay crisp without pulling in their neighbours", () => {
		expect([...crispNodeIndices([0, 3], [0], neighbours)].sort()).toEqual([0, 1, 2, 3]);
		expect([...crispNodeIndices([3], [], neighbours)]).toEqual([3]);
	});

	test("a cap keeps the anchors before any neighbour", () => {
		expect([...crispNodeIndices([0, 3], [0], neighbours, 2)].sort()).toEqual([0, 3]);
	});

	test("edges are crisp when both ends are, including those between neighbours", () => {
		const nodes = crispNodeIndices([0], [0], neighbours);
		expect([...crispEdgeIndices(nodes, incidentOf, edgeNodes, [])].sort()).toEqual([0, 1, 2]);
	});

	test("explicitly selected edges stay crisp", () => {
		expect([...crispEdgeIndices(new Set([3]), incidentOf, edgeNodes, [1])]).toEqual([1]);
	});
});
