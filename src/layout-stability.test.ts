import { describe, expect, test } from "vitest";

import { DEFAULT_FORCE_SETTINGS } from "./force-layout";
import { measureLayoutStability } from "./layout-stability";
import { denseCommunities, sparseRandomGraph } from "./test-support/layout-quality";

function request(graph: { edges: Uint32Array; groups?: Uint32Array; nodeCount: number }) {
	return {
		clusters: graph.groups ?? new Uint32Array(graph.nodeCount),
		dimensions: 2 as const,
		edges: graph.edges,
		nodeCount: graph.nodeCount,
		settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle: "edge-t" as const },
	};
}

describe("measureLayoutStability", () => {
	const communities = denseCommunities(11, [60, 50, 40, 30], 16);

	test("is deterministic", () => {
		const first = measureLayoutStability(request(communities), { seeds: 3 });
		expect(measureLayoutStability(request(communities), { seeds: 3 })).toEqual(first);
	});

	test("scores separated dense communities clearly above the placebo", () => {
		const result = measureLayoutStability(request(communities), { seeds: 4 });
		expect(result.clusters.map((cluster) => cluster.size)).toEqual([60, 50, 40, 30]);
		expect(result.overall).toBeGreaterThan((result.placeboOverall ?? 1) + 0.15);
		for (const cluster of result.clusters) {
			expect(cluster.stability).toBeGreaterThan(cluster.placeboStability ?? 1);
		}
	});

	test("scores a random graph near its placebo", () => {
		const random = sparseRandomGraph(200, 5, 6);
		const result = measureLayoutStability(request(random), { seeds: 4 });
		expect(Math.abs(result.overall - (result.placeboOverall ?? 0))).toBeLessThan(0.1);
	});

	test("omits the placebo on request", () => {
		const result = measureLayoutStability(request(communities), { placebo: false, seeds: 2 });
		expect(result.placeboOverall).toBeNull();
		expect(result.clusters.every((cluster) => cluster.placeboStability === null)).toBe(true);
	});

	test("rejects invalid input", () => {
		const base = request(communities);
		expect(() => measureLayoutStability(base, { seeds: 1 })).toThrow(/seeds/);
		expect(() => measureLayoutStability(base, { seeds: 2.5 })).toThrow(/seeds/);
		expect(() => measureLayoutStability(base, { neighbours: 0 })).toThrow(/neighbours/);
		expect(() => measureLayoutStability(base, { neighbours: base.nodeCount })).toThrow(/neighbours/);
		expect(() => measureLayoutStability({ ...base, clusters: new Uint32Array(3) })).toThrow(/Cluster index count/);
		expect(() => measureLayoutStability({ ...base, edges: new Uint32Array([0]) })).toThrow(/pairs/);
		expect(() => measureLayoutStability({ ...base, edges: new Uint32Array([0, base.nodeCount]) })).toThrow(/outside/);
		expect(() => measureLayoutStability({ ...base, clusters: new Uint32Array(2), nodeCount: 2 })).toThrow(/nodeCount/);
	});
});
