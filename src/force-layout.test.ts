import { describe, expect, test } from "vitest";

import {
	computeClusteredForcePositions,
	computeForcePositions,
	createForceSimulation,
	DEFAULT_FORCE_SETTINGS,
	FORCE_LAYOUT_STYLE_PRESETS,
	FORCE_LAYOUT_STYLES,
	type ForceSettings,
	forceIterationCount,
} from "./force-layout";

test("keeps 2D force positions flat and gives 3D positions depth", () => {
	const edges = new Uint32Array([0, 1, 1, 2]);
	const flat = computeForcePositions({ dimensions: 2, edges, nodeCount: 4 });
	const spatial = computeForcePositions({ dimensions: 3, edges, nodeCount: 4 });

	expect(Array.from(flat.filter((_, index) => index % 3 === 2))).toEqual([0, 0, 0, 0]);
	expect(Array.from(spatial.filter((_, index) => index % 3 === 2))).not.toEqual([0, 0, 0, 0]);
});

test("reduces force iterations as node count grows", () => {
	expect(forceIterationCount(100)).toBeGreaterThan(forceIterationCount(10_000));
	expect(forceIterationCount(10_000)).toBeGreaterThan(forceIterationCount(100_000));
	expect(forceIterationCount(1_000_000)).toBeGreaterThanOrEqual(8);
});

test("honors an explicit iteration count", () => {
	const request = { dimensions: 2 as const, edges: new Uint32Array([0, 1]), nodeCount: 8 };
	const once = computeForcePositions({ ...request, iterations: 1 });
	const twice = computeForcePositions({ ...request, iterations: 2 });
	expect(twice).not.toEqual(once);
	expect(() => computeForcePositions({ ...request, iterations: 0 })).toThrow(/positive integer/);
});

test("keeps a 10k-node force layout finite", () => {
	const nodeCount = 10_000;
	const edges = new Uint32Array((nodeCount - 1) * 2);
	for (let index = 0; index < nodeCount - 1; index += 1) edges.set([index, index + 1], index * 2);

	const positions = computeForcePositions({ dimensions: 3, edges, nodeCount });

	expect(positions.every(Number.isFinite)).toBe(true);
});

test("does not preserve a circular seed", () => {
	const positions = computeForcePositions({ dimensions: 2, edges: new Uint32Array(), nodeCount: 64 });
	const radii = Array.from({ length: 64 }, (_, index) =>
		Math.round(Math.hypot(positions[index * 3] ?? 0, positions[index * 3 + 1] ?? 0)),
	);

	expect(new Set(radii).size).toBeGreaterThan(10);
});

test("expands a coarse force layout from data cluster indices", () => {
	const positions = computeClusteredForcePositions({
		clusters: new Uint32Array([0, 0, 1, 1]),
		dimensions: 2,
		edges: new Uint32Array([0, 1, 2, 3, 1, 2]),
		nodeCount: 4,
	});
	const distance = (left: number, right: number) =>
		Math.hypot(positions[left * 3] - positions[right * 3], positions[left * 3 + 1] - positions[right * 3 + 1]);

	expect(distance(0, 1)).toBeLessThan(distance(0, 2));
	expect(positions.filter((_, index) => index % 3 === 2).every((value) => value === 0)).toBe(true);
});

test("applies force settings and recenters every live step", () => {
	const request = { dimensions: 2 as const, edges: new Uint32Array([0, 1, 1, 2]), nodeCount: 4 };
	const baseline = computeForcePositions(request);
	const tuned = computeForcePositions({
		...request,
		settings: { ...DEFAULT_FORCE_SETTINGS, repulsion: 2_000, springStrength: 0.02 },
	});
	const simulation = createForceSimulation(request);
	simulation.step(0.35);
	const center = [0, 0];
	for (let index = 0; index < request.nodeCount; index += 1) {
		center[0] += simulation.positions[index * 3] ?? 0;
		center[1] += simulation.positions[index * 3 + 1] ?? 0;
	}

	expect(tuned).not.toEqual(baseline);
	expect(center[0] / request.nodeCount).toBeCloseTo(0, 5);
	expect(center[1] / request.nodeCount).toBeCloseTo(0, 5);
});

test("adds nodes and edges without resetting existing layout state", () => {
	const simulation = createForceSimulation({ dimensions: 2, edges: new Uint32Array([0, 1]), nodeCount: 2 });
	simulation.step(0.35);
	const before = Array.from(simulation.positions.slice(0, 6));

	const start = simulation.addNodes(1, new Float32Array([12, 8, 0]));
	simulation.addEdges(new Uint32Array([1, start]));

	expect(start).toBe(2);
	expect(simulation.nodeCount).toBe(3);
	expect(Array.from(simulation.positions.slice(0, 6))).toEqual(before);
	expect(Array.from(simulation.edges)).toEqual([0, 1, 1, 2]);
	simulation.step(0.2);
	expect(simulation.positions.every(Number.isFinite)).toBe(true);
});

test("omitted per-edge spring arrays match global-only layout", () => {
	const request = { dimensions: 2 as const, edges: new Uint32Array([0, 1, 1, 2]), nodeCount: 4, iterations: 8 };
	const baseline = computeForcePositions(request);
	const withSameDefaults = computeForcePositions({
		...request,
		linkDistances: new Float32Array([DEFAULT_FORCE_SETTINGS.linkDistance, DEFAULT_FORCE_SETTINGS.linkDistance]),
		springStrengths: new Float32Array([DEFAULT_FORCE_SETTINGS.springStrength, DEFAULT_FORCE_SETTINGS.springStrength]),
	});
	expect(Array.from(withSameDefaults)).toEqual(Array.from(baseline));
});

test("per-edge link distances change rest length versus global defaults", () => {
	const edges = new Uint32Array([0, 1]);
	const short = computeForcePositions({
		dimensions: 2,
		edges,
		nodeCount: 2,
		iterations: 24,
		linkDistances: new Float32Array([8]),
	});
	const long = computeForcePositions({
		dimensions: 2,
		edges,
		nodeCount: 2,
		iterations: 24,
		linkDistances: new Float32Array([80]),
	});
	const shortDist = Math.hypot((short[0] ?? 0) - (short[3] ?? 0), (short[1] ?? 0) - (short[4] ?? 0));
	const longDist = Math.hypot((long[0] ?? 0) - (long[3] ?? 0), (long[1] ?? 0) - (long[4] ?? 0));
	expect(longDist).toBeGreaterThan(shortDist);
});

test("rejects per-edge spring arrays whose length does not match the edge count", () => {
	const request = { dimensions: 2 as const, edges: new Uint32Array([0, 1, 1, 2]), nodeCount: 3 };
	expect(() => createForceSimulation({ ...request, linkDistances: new Float32Array([10]) })).toThrow(/linkDistances/);
	expect(() => createForceSimulation({ ...request, springStrengths: new Float32Array([0.01]) })).toThrow(
		/springStrengths/,
	);
});

const SIMULATION_STEPS = 40;

function runSteps(simulation: ReturnType<typeof createForceSimulation>, steps = SIMULATION_STEPS) {
	for (let step = 0; step < steps; step += 1) simulation.step(1 - step / steps);
}

/** Three 12-node rings joined by two sparse inter-cluster edges. */
function clusteredFixture(dimensions: 2 | 3 = 2) {
	const clusterSize = 12;
	const clusterCount = 3;
	const nodeCount = clusterSize * clusterCount;
	const clusters = new Uint32Array(nodeCount);
	const edges: number[] = [];
	for (let cluster = 0; cluster < clusterCount; cluster += 1) {
		for (let member = 0; member < clusterSize; member += 1) {
			const node = cluster * clusterSize + member;
			clusters[node] = cluster;
			edges.push(node, cluster * clusterSize + ((member + 1) % clusterSize));
		}
	}
	edges.push(0, clusterSize, clusterSize, clusterSize * 2);
	return { clusters, dimensions, edges: new Uint32Array(edges), nodeCount };
}

function meanIntraClusterDistance(positions: Float32Array, clusters: Uint32Array) {
	let total = 0;
	let pairs = 0;
	for (let left = 0; left < clusters.length; left += 1) {
		for (let right = left + 1; right < clusters.length; right += 1) {
			if (clusters[left] !== clusters[right]) continue;
			total += Math.hypot(
				(positions[left * 3] ?? 0) - (positions[right * 3] ?? 0),
				(positions[left * 3 + 1] ?? 0) - (positions[right * 3 + 1] ?? 0),
				(positions[left * 3 + 2] ?? 0) - (positions[right * 3 + 2] ?? 0),
			);
			pairs += 1;
		}
	}
	return total / pairs;
}

test("keeps the unclustered simulation output unchanged", () => {
	const edges = new Uint32Array([0, 1, 1, 2, 2, 3, 3, 4, 4, 0, 5, 6]);
	const spatial = createForceSimulation({ dimensions: 3, edges, nodeCount: 8 });
	runSteps(spatial, 20);
	const grown = createForceSimulation({ dimensions: 2, edges, nodeCount: 8 });
	grown.addNodes(2);
	runSteps(grown, 20);

	expect(Array.from(spatial.positions)).toEqual([
		25.800647735595703, 12.869406700134277, -54.71083450317383, 10.229402542114258, 36.294097900390625,
		43.187782287597656, 70.74805450439453, 10.596172332763672, -2.0452959537506104, 5.167520523071289,
		63.36275863647461, -1.8073502779006958, -29.628725051879883, -31.693632125854492, -52.944313049316406,
		-44.96399688720703, 1.0935823917388916, -22.190250396728516, -32.45338439941406, -66.55451202392578,
		14.691564559936523, -4.8995184898376465, -25.96787452697754, 75.81869506835938,
	]);
	expect(Array.from(grown.positions)).toEqual([
		54.128936767578125, -46.57068634033203, 0, -16.574390411376953, -24.014610290527344, 0, 72.40190887451172,
		6.6032209396362305, 0, -34.54827880859375, 65.60559844970703, 0, 2.770887613296509, -47.10395431518555, 0,
		3.0792860984802246, 54.561920166015625, 0, 8.261571884155273, -85.74687194824219, 0, -77.30206298828125,
		-10.281672477722168, 0, 52.00041198730469, 47.41092300415039, 0, -64.21827697753906, 39.53612518310547, 0,
	]);
});

test("ignores clusterStrength when no clusters are given", () => {
	const { clusters: _clusters, ...request } = clusteredFixture();
	const baseline = createForceSimulation(request);
	const strong = createForceSimulation({ ...request, settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 0.1 } });
	runSteps(baseline);
	runSteps(strong);

	expect(Array.from(strong.positions)).toEqual(Array.from(baseline.positions));
});

test("rejects a cluster array that does not match the node count", () => {
	const request = clusteredFixture();
	expect(() => createForceSimulation({ ...request, clusters: new Uint32Array(request.nodeCount - 1) })).toThrow(
		/Cluster index count/,
	);
});

test("does not mutate the caller's cluster array", () => {
	const request = clusteredFixture();
	const original = Array.from(request.clusters);
	const simulation = createForceSimulation(request);
	runSteps(simulation);
	simulation.addNodes(1, undefined, new Uint32Array([0]));
	runSteps(simulation, 2);

	expect(Array.from(request.clusters)).toEqual(original);
});

test("stores a copy of the caller's cluster array", () => {
	const request = clusteredFixture();
	const input = new Uint32Array(request.clusters);
	const simulation = createForceSimulation({ ...request, clusters: input });
	input.fill(0);
	runSteps(simulation);
	const reference = createForceSimulation(request);
	runSteps(reference);

	expect(Array.from(simulation.positions)).toEqual(Array.from(reference.positions));
});

test("rejects sparse cluster ids in a live simulation but not in the one-shot layout", () => {
	const request = clusteredFixture();
	const sparse = new Uint32Array(request.clusters);
	sparse[0] = request.nodeCount;
	const lastValid = new Uint32Array(request.clusters);
	lastValid[0] = request.nodeCount - 1;

	expect(() => createForceSimulation({ ...request, clusters: sparse })).toThrow(
		/Cluster index 36 exceeds the node count 36; use dense ids starting at 0/,
	);
	expect(() => createForceSimulation({ ...request, clusters: lastValid })).not.toThrow();
	expect(() =>
		computeClusteredForcePositions({
			clusters: new Uint32Array([0, 5]),
			dimensions: 2,
			edges: new Uint32Array([0, 1]),
			nodeCount: 2,
		}),
	).not.toThrow();
});

test("seeds a clustered simulation exactly like the one-shot clustered layout", () => {
	for (const dimensions of [2, 3] as const) {
		const request = clusteredFixture(dimensions);
		const simulation = createForceSimulation(request);

		expect(Array.from(simulation.positions)).toEqual(Array.from(computeClusteredForcePositions(request)));
	}
});

test("pulls clustered nodes together while the simulation runs", () => {
	for (const dimensions of [2, 3] as const) {
		const request = clusteredFixture(dimensions);
		const unclustered = createForceSimulation({ ...request, clusters: undefined });
		const withoutPull = createForceSimulation({
			...request,
			settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 0 },
		});
		const pulled = createForceSimulation({
			...request,
			settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 0.05 },
		});
		runSteps(unclustered);
		runSteps(withoutPull);
		runSteps(pulled);
		const cohesion = (simulation: ReturnType<typeof createForceSimulation>) =>
			meanIntraClusterDistance(simulation.positions, request.clusters);

		expect(cohesion(pulled)).toBeLessThan(cohesion(unclustered));
		expect(cohesion(pulled)).toBeLessThan(cohesion(withoutPull));
		expect(pulled.positions.every(Number.isFinite)).toBe(true);
	}
});

test("scales the cluster pull by the step alpha", () => {
	const request = clusteredFixture();
	const pulled = () =>
		createForceSimulation({ ...request, settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 0.1 } });
	const unpulled = () =>
		createForceSimulation({ ...request, settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 0 } });
	const [settledPulled, settledUnpulled, activePulled, activeUnpulled] = [pulled(), unpulled(), pulled(), unpulled()];
	settledPulled.step(0);
	settledUnpulled.step(0);
	activePulled.step(1);
	activeUnpulled.step(1);

	expect(Array.from(settledPulled.positions)).toEqual(Array.from(settledUnpulled.positions));
	expect(Array.from(activePulled.positions)).not.toEqual(Array.from(activeUnpulled.positions));
});

test("a zero cluster strength only changes the seeding", () => {
	const request = clusteredFixture();
	const clustered = createForceSimulation({ ...request, settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 0 } });
	const unclustered = createForceSimulation({ ...request, clusters: undefined });
	unclustered.positions.set(clustered.positions);
	runSteps(clustered);
	runSteps(unclustered);

	expect(Array.from(clustered.positions)).toEqual(Array.from(unclustered.positions));
});

test("adds clustered nodes while preserving existing layout state", () => {
	const request = clusteredFixture();
	const simulation = createForceSimulation(request);
	runSteps(simulation, 5);
	const before = Array.from(simulation.positions);

	const start = simulation.addNodes(3, undefined, new Uint32Array([0, 1, 3]));
	simulation.addEdges(new Uint32Array([start, 0, start + 2, start + 1]));

	expect(start).toBe(request.nodeCount);
	expect(Array.from(simulation.positions.slice(0, before.length))).toEqual(before);
	runSteps(simulation, 5);
	expect(simulation.positions.every(Number.isFinite)).toBe(true);
});

test("a node that introduces a new cluster id is its own centroid and feels no pull", () => {
	const request = { dimensions: 2 as const, edges: new Uint32Array(), nodeCount: 1 };
	const pulled = createForceSimulation({ ...request, clusters: new Uint32Array([0]) });
	const unpulled = createForceSimulation({
		...request,
		clusters: new Uint32Array([0]),
		settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 0 },
	});
	for (const simulation of [pulled, unpulled]) {
		simulation.addNodes(1, new Float32Array([50, 20, 0]), new Uint32Array([1]));
		runSteps(simulation, 5);
	}

	expect(Array.from(pulled.positions)).toEqual(Array.from(unpulled.positions));
});

test("leaves the simulation usable when addNodes rejects a cluster id", () => {
	const simulation = createForceSimulation(clusteredFixture());
	runSteps(simulation, 3);

	expect(() => simulation.addNodes(1, undefined, new Uint32Array([4_294_967_295]))).toThrow(/dense ids/);
	expect(simulation.nodeCount).toBe(36);
	expect(simulation.positions.length).toBe(36 * 3);
	runSteps(simulation, 3);
	expect(simulation.positions.every(Number.isFinite)).toBe(true);
	expect(simulation.addNodes(2, undefined, new Uint32Array([0, 3]))).toBe(36);
	runSteps(simulation, 3);
	expect(simulation.nodeCount).toBe(38);
	expect(simulation.positions.every(Number.isFinite)).toBe(true);
});

test("requires cluster indices when adding nodes to a clustered simulation", () => {
	const simulation = createForceSimulation(clusteredFixture());

	expect(() => simulation.addNodes(2)).toThrow(/clusters/);
	expect(() => simulation.addNodes(2, undefined, new Uint32Array([0]))).toThrow(/Cluster index count/);
	expect(simulation.nodeCount).toBe(36);
});

test("rejects cluster indices when adding nodes to an unclustered simulation", () => {
	const { clusters: _clusters, ...request } = clusteredFixture();
	const simulation = createForceSimulation(request);

	expect(() => simulation.addNodes(1, undefined, new Uint32Array([0]))).toThrow(/without clusters/);
	expect(simulation.nodeCount).toBe(36);
});

test("clamps clusterStrength into its supported range", () => {
	const request = clusteredFixture();
	const clamped = createForceSimulation({ ...request, settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 5 } });
	const maximum = createForceSimulation({ ...request, settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 0.1 } });
	const negative = createForceSimulation({ ...request, settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: -1 } });
	const zero = createForceSimulation({ ...request, settings: { ...DEFAULT_FORCE_SETTINGS, clusterStrength: 0 } });
	for (const simulation of [clamped, maximum, negative, zero]) runSteps(simulation, 10);

	expect(Array.from(clamped.positions)).toEqual(Array.from(maximum.positions));
	expect(Array.from(negative.positions)).toEqual(Array.from(zero.positions));
});

test("computeForcePositions honours clusters through the live simulation", () => {
	const request = clusteredFixture();
	const { clusters: _clusters, ...unclustered } = request;
	const clustered = computeForcePositions({ ...request, iterations: 16 });

	expect(Array.from(clustered)).not.toEqual(Array.from(computeForcePositions({ ...unclustered, iterations: 16 })));
	expect(meanIntraClusterDistance(clustered, request.clusters)).toBeLessThan(
		meanIntraClusterDistance(computeForcePositions({ ...unclustered, iterations: 16 }), request.clusters),
	);
});

describe("layoutStyle", () => {
	const ring = (nodeCount: number) => {
		const edges = new Uint32Array(nodeCount * 2);
		for (let index = 0; index < nodeCount; index += 1) edges.set([index, (index + 1) % nodeCount], index * 2);
		return { dimensions: 2 as const, edges, nodeCount };
	};
	const edgeT = { ...DEFAULT_FORCE_SETTINGS, layoutStyle: "edge-t" as const };
	const spread = (positions: Float32Array) => {
		let total = 0;
		for (let index = 0; index < positions.length; index += 3) {
			total += Math.hypot(positions[index] ?? 0, positions[index + 1] ?? 0, positions[index + 2] ?? 0);
		}
		return total / (positions.length / 3);
	};

	test("pins the documented style presets", () => {
		expect(FORCE_LAYOUT_STYLES).toEqual(["classic", "edge-t"]);
		expect(FORCE_LAYOUT_STYLE_PRESETS).toEqual({
			classic: {
				clusterGain: 1,
				iterationScale: 1,
				maxIterations: 64,
				repulsion: "node-sampled-inverse-square",
				repulsionGain: 1,
				springGain: 1,
			},
			"edge-t": {
				clusterGain: 2.5,
				iterationScale: 8,
				maxIterations: 512,
				repulsion: "edge-sampled-student-t",
				repulsionGain: 4,
				springGain: 10,
			},
		});
	});

	test("defaults to classic and keeps classic positions unchanged", () => {
		const request = ring(32);
		expect(createForceSimulation(request).settings.layoutStyle).toBe("classic");
		expect(
			computeForcePositions({ ...request, settings: { ...DEFAULT_FORCE_SETTINGS, layoutStyle: "classic" } }),
		).toEqual(computeForcePositions(request));
	});

	test("is deterministic for edge-t and differs from classic", () => {
		const request = { ...ring(64), settings: edgeT };
		const first = computeForcePositions(request);
		expect(computeForcePositions(request)).toEqual(first);
		expect(first.every(Number.isFinite)).toBe(true);
		expect(first).not.toEqual(computeForcePositions(ring(64)));
	});

	test("clamps edge-t parameters like the other settings", () => {
		const clamped = createForceSimulation({
			...ring(4),
			settings: { ...edgeT, negativeSamples: 100.4, tDegrees: 0 },
		}).settings;
		expect(clamped.negativeSamples).toBe(16);
		expect(clamped.tDegrees).toBe(0.5);
		const low = createForceSimulation({
			...ring(4),
			settings: { ...DEFAULT_FORCE_SETTINGS, negativeSamples: -3, tDegrees: 99 },
		}).settings;
		expect(low.negativeSamples).toBe(1);
		expect(low.tDegrees).toBe(10);
	});

	test("falls back to defaults for NaN settings", () => {
		const settings = createForceSimulation({
			...ring(4),
			settings: {
				centerAttraction: Number.NaN,
				damping: Number.NaN,
				linkDistance: Number.NaN,
				negativeSamples: Number.NaN,
				repulsion: Number.NaN,
				springStrength: Number.NaN,
				tDegrees: Number.NaN,
			},
		}).settings;
		expect(settings).toEqual(DEFAULT_FORCE_SETTINGS);
	});

	test("rejects an unknown style", () => {
		const settings = { ...DEFAULT_FORCE_SETTINGS, layoutStyle: "spring" } as unknown as ForceSettings;
		expect(() => createForceSimulation({ ...ring(4), settings })).toThrow(/Unknown layoutStyle "spring"/);
	});

	test("caps explicit iterations per style", () => {
		const request = ring(16);
		expect(computeForcePositions({ ...request, iterations: 1_000 })).toEqual(
			computeForcePositions({ ...request, iterations: 64 }),
		);
		expect(computeForcePositions({ ...request, iterations: 1_000, settings: edgeT })).toEqual(
			computeForcePositions({ ...request, iterations: 512, settings: edgeT }),
		);
	});

	test("lays out an empty graph", () => {
		const request = { dimensions: 2 as const, edges: new Uint32Array(), nodeCount: 0, settings: edgeT };
		expect(computeForcePositions(request)).toHaveLength(0);
		const simulation = createForceSimulation(request);
		expect(() => simulation.step(0.35)).not.toThrow();
	});

	test("uses tDegrees and negativeSamples", () => {
		const request = ring(48);
		const base = computeForcePositions({ ...request, settings: edgeT });
		const heavy = computeForcePositions({ ...request, settings: { ...edgeT, tDegrees: 3.5 } });
		const sampled = computeForcePositions({ ...request, settings: { ...edgeT, negativeSamples: 5 } });
		expect(heavy.every(Number.isFinite)).toBe(true);
		expect(heavy).not.toEqual(base);
		expect(sampled).not.toEqual(base);
	});

	test("pushes isolated nodes apart", () => {
		// No center pull and no edges: only the repulsion moves nodes, so the cloud must grow.
		const simulation = createForceSimulation({
			dimensions: 3,
			edges: new Uint32Array(),
			nodeCount: 50,
			settings: { ...edgeT, centerAttraction: 0 },
		});
		const before = spread(simulation.positions);
		for (let step = 0; step < 30; step += 1) simulation.step(0.35);
		expect(spread(simulation.positions)).toBeGreaterThan(before * 1.1);
	});

	test("counts degrees of added edges like edges given at creation", () => {
		const { edges, nodeCount } = ring(30);
		const created = createForceSimulation({ dimensions: 2, edges, nodeCount, settings: edgeT });
		const added = createForceSimulation({ dimensions: 2, edges: new Uint32Array(), nodeCount, settings: edgeT });
		added.addEdges(edges);
		for (let step = 0; step < 10; step += 1) {
			created.step(0.35);
			added.step(0.35);
		}
		expect(added.positions).toEqual(created.positions);
	});

	test("keeps a 5k-leaf hub finite and its star compact", () => {
		const leaves = 5_000;
		const edges = new Uint32Array(leaves * 2);
		for (let leaf = 1; leaf <= leaves; leaf += 1) edges.set([0, leaf], (leaf - 1) * 2);
		const positions = computeForcePositions({ dimensions: 2, edges, nodeCount: leaves + 1, settings: edgeT });
		expect(positions.every(Number.isFinite)).toBe(true);
		const lengths = Array.from({ length: leaves }, (_, index) =>
			Math.hypot(
				(positions[(index + 1) * 3] ?? 0) - (positions[0] ?? 0),
				(positions[(index + 1) * 3 + 1] ?? 0) - (positions[1] ?? 0),
			),
		).sort((left, right) => left - right);
		// The hub stays inside its own star and the leaves stay within a few link distances of it.
		expect(Math.hypot(positions[0] ?? 0, positions[1] ?? 0)).toBeLessThan(spread(positions) * 1.5);
		expect(lengths[leaves >> 1]).toBeLessThan(DEFAULT_FORCE_SETTINGS.linkDistance * 3);
	});

	test("switches style on a live simulation without re-seeding", () => {
		const simulation = createForceSimulation(ring(48));
		for (let step = 0; step < 10; step += 1) simulation.step(0.35);
		const before = simulation.positions.slice();
		simulation.setSettings({ layoutStyle: "edge-t" });
		expect(simulation.positions).toEqual(before);
		expect(simulation.settings.layoutStyle).toBe("edge-t");
		simulation.step(0.35);
		expect(simulation.positions).not.toEqual(before);
		expect(simulation.positions.every(Number.isFinite)).toBe(true);
		const settingsBefore = simulation.settings;
		expect(() => simulation.setSettings({ layoutStyle: "nope" } as unknown as ForceSettings)).toThrow(
			/Unknown layoutStyle/,
		);
		expect(simulation.settings).toBe(settingsBefore);
	});

	test("merges a settings patch and keeps omitted values", () => {
		const simulation = createForceSimulation({
			...ring(8),
			settings: { ...edgeT, clusterStrength: 0.07, negativeSamples: 6, repulsion: 900, tDegrees: 2 },
		});
		simulation.setSettings({ damping: 0.7 });
		expect(simulation.settings).toEqual({
			...edgeT,
			clusterStrength: 0.07,
			damping: 0.7,
			negativeSamples: 6,
			repulsion: 900,
			tDegrees: 2,
		});
		simulation.setSettings({ repulsion: Number.NaN, tDegrees: undefined });
		expect(simulation.settings.repulsion).toBe(900);
		expect(simulation.settings.tDegrees).toBe(2);
	});

	test("matches a simulation that never switched after switching back", () => {
		const request = ring(24);
		const switched = createForceSimulation(request);
		switched.setSettings({ layoutStyle: "edge-t" });
		switched.setSettings({ layoutStyle: "classic" });
		const plain = createForceSimulation(request);
		for (let step = 0; step < 5; step += 1) {
			switched.step(0.35);
			plain.step(0.35);
		}
		expect(switched.positions).toEqual(plain.positions);
	});

	test("switches style on a clustered simulation with added nodes", () => {
		const simulation = createForceSimulation({
			clusters: new Uint32Array([0, 0, 0, 1, 1, 1]),
			dimensions: 2,
			edges: new Uint32Array([0, 1, 1, 2, 3, 4, 4, 5, 2, 3]),
			nodeCount: 6,
		});
		simulation.addNodes(2, undefined, new Uint32Array([1, 2]));
		simulation.addEdges(new Uint32Array([5, 6, 6, 7]));
		simulation.setSettings({ layoutStyle: "edge-t" });
		for (let step = 0; step < 40; step += 1) simulation.step(0.35);
		expect(simulation.positions).toHaveLength(24);
		expect(simulation.positions.every(Number.isFinite)).toBe(true);
	});
});

describe("anchors", () => {
	const twoGroups = (dimensions: 2 | 3, scale = 1) => {
		const nodeCount = 20;
		const positions = new Float32Array(nodeCount * dimensions);
		for (let node = 0; node < nodeCount; node += 1) {
			positions[node * dimensions] = (node < 10 ? -1 : 1) * scale;
			if (dimensions === 3) positions[node * dimensions + 2] = ((node % 3) - 1) * 0.1 * scale;
		}
		return { nodeCount, positions };
	};
	const run = (request: Parameters<typeof computeForcePositions>[0]) => computeForcePositions(request);
	/** Mean x of nodes `from` to `to`. */
	const meanX = (positions: Float32Array, from: number, to: number) => {
		let sum = 0;
		for (let node = from; node < to; node += 1) sum += positions[node * 3] ?? 0;
		return sum / (to - from);
	};
	const gap = (positions: Float32Array) => meanX(positions, 10, 20) - meanX(positions, 0, 10);

	test("rejects anchor positions of the wrong length", () => {
		expect(() =>
			createForceSimulation({
				anchors: { positions: new Float32Array(5) },
				dimensions: 3,
				edges: new Uint32Array(),
				nodeCount: 2,
			}),
		).toThrow(/Anchor positions length \(5\) must equal node count \(2\) times dimensions \(3\) = 6/);
	});

	test("rejects a per-node strength array of the wrong length", () => {
		expect(() =>
			createForceSimulation({
				anchors: { positions: new Float32Array(4), strength: new Float32Array(3) },
				dimensions: 2,
				edges: new Uint32Array(),
				nodeCount: 2,
			}),
		).toThrow(/Anchor strength length \(3\) must equal node count \(2\)/);
	});

	test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects anchor strength %s", (strength) => {
		const request = { dimensions: 2 as const, edges: new Uint32Array(), nodeCount: 2 };
		const positions = new Float32Array(4);
		expect(() => createForceSimulation({ ...request, anchors: { positions, strength } })).toThrow(
			/Anchor strength must be a finite number of at least 0/,
		);
		expect(() =>
			createForceSimulation({ ...request, anchors: { positions, strength: new Float32Array([1, strength]) } }),
		).toThrow(/Anchor strength at index 1 must be a finite number of at least 0/);
	});

	test("rejects infinite anchor positions but lets NaN skip a node", () => {
		const request = { dimensions: 2 as const, edges: new Uint32Array(), nodeCount: 2 };
		const infinite = new Float32Array([0, 0, Number.POSITIVE_INFINITY, 1]);
		expect(() => createForceSimulation({ ...request, anchors: { positions: infinite } })).toThrow(/finite or NaN/);
		const skipped = new Float32Array([0, 0, Number.NaN, 1]);
		expect(() => createForceSimulation({ ...request, anchors: { positions: skipped } })).not.toThrow();
	});

	test("clamps anchorStrength to 0..0.1", () => {
		const resolved = (anchorStrength: number) =>
			createForceSimulation({
				dimensions: 2,
				edges: new Uint32Array(),
				nodeCount: 1,
				settings: { ...DEFAULT_FORCE_SETTINGS, anchorStrength },
			}).settings.anchorStrength;
		expect(resolved(5)).toBe(0.1);
		expect(resolved(-1)).toBe(0);
		expect(resolved(Number.NaN)).toBe(DEFAULT_FORCE_SETTINGS.anchorStrength);
	});

	test("a request without usable anchors lays out exactly as before", () => {
		const request = { dimensions: 3 as const, edges: new Uint32Array([0, 1, 1, 2, 2, 3]), nodeCount: 6 };
		const baseline = run(request);
		// Values recorded before anchors existed: the no-anchor path must not drift.
		const recorded = [
			28.638078689575195, -8.999749183654785, -51.357933044433594, 18.782024383544922, -22.212722778320312,
			46.13385009765625,
		];
		recorded.forEach((value, index) => {
			expect(baseline[index]).toBeCloseTo(value, 3);
		});
		expect(Array.from(run({ ...request, anchors: undefined }))).toEqual(Array.from(baseline));
		const allSkipped = { positions: new Float32Array(18).fill(Number.NaN) };
		expect(Array.from(run({ ...request, anchors: allSkipped }))).toEqual(Array.from(baseline));
	});

	test("anchor strength 0 equals no anchors", () => {
		const request = { dimensions: 2 as const, edges: new Uint32Array([0, 1, 1, 2]), nodeCount: 20 };
		const { positions } = twoGroups(2);
		const baseline = Array.from(run(request));
		expect(Array.from(run({ ...request, anchors: { positions, strength: 0 } }))).toEqual(baseline);
		const off = { ...DEFAULT_FORCE_SETTINGS, anchorStrength: 0 };
		expect(Array.from(run({ ...request, anchors: { positions }, settings: off }))).toEqual(baseline);
	});

	test("anchors separate isolated nodes into the groups they are anchored to", () => {
		const { nodeCount, positions } = twoGroups(3);
		const request = { dimensions: 3 as const, edges: new Uint32Array(), nodeCount };
		const anchored = run({ ...request, anchors: { positions } });
		expect(gap(anchored)).toBeGreaterThan(20);
		for (let node = 0; node < 10; node += 1) expect(anchored[node * 3]).toBeLessThan(anchored[(node + 10) * 3] ?? 0);
		expect(Math.abs(gap(run(request)))).toBeLessThan(gap(anchored));
	});

	test("a node without an anchor keeps the default start", () => {
		const { nodeCount, positions } = twoGroups(2);
		positions.fill(Number.NaN, 0, 2);
		const request = { dimensions: 2 as const, edges: new Uint32Array(), nodeCount };
		const anchored = createForceSimulation({ ...request, anchors: { positions } });
		const plain = createForceSimulation(request);
		expect(Array.from(anchored.positions.slice(0, 3))).toEqual(Array.from(plain.positions.slice(0, 3)));
		expect(Array.from(anchored.positions.slice(3, 6))).not.toEqual(Array.from(plain.positions.slice(3, 6)));
	});

	test("anchors are rescaled, so a range of 10 gives the same layout as a range of 1", () => {
		const edges = new Uint32Array([0, 1, 10, 11]);
		const small = twoGroups(3, 1);
		const large = twoGroups(3, 10);
		const a = run({ anchors: { positions: small.positions }, dimensions: 3, edges, nodeCount: small.nodeCount });
		const b = run({ anchors: { positions: large.positions }, dimensions: 3, edges, nodeCount: large.nodeCount });
		for (let index = 0; index < a.length; index += 1) expect(b[index]).toBeCloseTo(a[index] ?? 0, 3);
	});

	test("per-node strength weights the pull", () => {
		const { nodeCount, positions } = twoGroups(2);
		const strength = new Float32Array(nodeCount).fill(1);
		strength.fill(0, 10);
		const settings = { ...DEFAULT_FORCE_SETTINGS, anchorStrength: 0.1, repulsion: 0 };
		const layout = run({
			anchors: { positions, strength },
			dimensions: 2,
			edges: new Uint32Array(),
			nodeCount,
			settings,
		});
		// Targets sit at x = +-13.4 (half of the default extent); only the first group is pulled to its side.
		const miss = (from: number, to: number) => {
			let sum = 0;
			for (let node = from; node < to; node += 1) sum += Math.abs(Math.abs(layout[node * 3] ?? 0) - 13.4);
			return sum / (to - from);
		};
		expect(miss(0, 10)).toBeLessThan(miss(10, 20));
	});

	test("anchor targets scale with linkDistance", () => {
		const { nodeCount, positions } = twoGroups(3);
		const request = { dimensions: 3 as const, edges: new Uint32Array(), nodeCount };
		const at = (linkDistance: number) =>
			createForceSimulation({
				...request,
				anchors: { positions },
				settings: { ...DEFAULT_FORCE_SETTINGS, linkDistance },
			});
		const base = gap(at(24).positions);
		const doubled = gap(at(48).positions);
		expect(doubled / base).toBeGreaterThan(1.6);
		expect(doubled / base).toBeLessThan(2.4);
		const settled = (linkDistance: number) =>
			gap(
				run({
					...request,
					anchors: { positions },
					settings: { ...DEFAULT_FORCE_SETTINGS, anchorStrength: 0.1, linkDistance, repulsion: 0 },
				}),
			);
		expect(settled(48) / settled(24)).toBeGreaterThan(1.6);
		expect(settled(48) / settled(24)).toBeLessThan(2.4);
	});

	test("setSettings re-derives targets like creating with that linkDistance", () => {
		const { nodeCount, positions } = twoGroups(3);
		const request = { dimensions: 3 as const, edges: new Uint32Array(), nodeCount };
		const created = createForceSimulation({
			...request,
			anchors: { positions },
			settings: { ...DEFAULT_FORCE_SETTINGS, linkDistance: 100 },
		});
		const changed = createForceSimulation({ ...request, anchors: { positions } });
		changed.setSettings({ linkDistance: 100 });
		for (const simulation of [created, changed]) simulation.step(0);
		// A zero-alpha step has no force, so only the targets can differ: compare through a pulled run.
		const pulled = (simulation: ReturnType<typeof createForceSimulation>) => {
			simulation.setSettings({ anchorStrength: 0.1, repulsion: 0, centerAttraction: 0 });
			for (let step = 0; step < 200; step += 1) simulation.step(1);
			return Array.from(simulation.positions);
		};
		const a = pulled(created);
		const b = pulled(changed);
		for (let index = 0; index < a.length; index += 1) expect(b[index]).toBeCloseTo(a[index] ?? 0, 0);
		// Added anchors use the current scale: node 0 and a new node at the same raw spot agree.
		const start = changed.addNodes(1, undefined, undefined, { positions: new Float32Array([-1, 0, 0]) });
		expect(changed.positions[start * 3] ?? 0).toBeCloseTo(changed.positions[0] ?? 0, -1);
	});

	test("addNodes takes anchors for added nodes; others stay unanchored", () => {
		const { nodeCount, positions } = twoGroups(2);
		const request = { dimensions: 2 as const, edges: new Uint32Array(), nodeCount };
		const simulation = createForceSimulation({ ...request, anchors: { positions } });
		const start = simulation.addNodes(2, undefined, undefined, { positions: new Float32Array([1, 0, Number.NaN, 0]) });
		expect(simulation.nodeCount).toBe(22);
		expect(simulation.positions[start * 3] ?? 0).toBeGreaterThan(5);
		const wrong = { positions: new Float32Array(1) };
		expect(() => simulation.addNodes(1, undefined, undefined, wrong)).toThrow(/Anchor positions length/);
		expect(simulation.nodeCount).toBe(22);
		simulation.addNodes(1);
		for (let step = 0; step < 5; step += 1) simulation.step(1);
		expect(simulation.positions.every(Number.isFinite)).toBe(true);
	});

	test("addNodes rejects anchors on a simulation created without them", () => {
		const simulation = createForceSimulation({ dimensions: 2, edges: new Uint32Array(), nodeCount: 2 });
		expect(() => simulation.addNodes(1, undefined, undefined, { positions: new Float32Array(2) })).toThrow(
			/created without anchors/,
		);
	});
});
