import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import { Graphraum } from "./graphraum";
import { attachClusterLod, buildClusterTree, type ClusterLodHandle, nodeColorKeys } from "./lod";
import { FakeElement, installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumCameraState, GraphraumData, GraphraumNode } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));

const graphs: Graphraum[] = [];
afterEach(() => {
	for (const graph of graphs.splice(0)) graph.destroy();
});

const COLORS = ["#e63946", "#2a9d8f", "#457b9d"];
const TOTAL = 6000;

function fixture(count: number, dimensions: 2 | 3): GraphraumData {
	const side = Math.ceil(Math.cbrt(TOTAL));
	return {
		edges: Array.from({ length: count * 2 }, (_, index) => ({
			id: `e${index}`,
			source: `n${index % count}`,
			target: `n${(index * 31 + 7) % count}`,
		})),
		nodes: Array.from({ length: count }, (_, index) => ({
			color: COLORS[(index * 7) % COLORS.length],
			id: `n${index}`,
			position:
				dimensions === 3
					? {
							x: (index % side) * 10,
							y: (Math.floor(index / side) % side) * 10,
							z: Math.floor(index / (side * side)) * 10,
						}
					: { x: (index % 80) * 10, y: Math.floor(index / 80) * 10 },
			size: 2,
		})),
	};
}

function treeOf(data: GraphraumData, dimensions: 2 | 3) {
	return buildClusterTree({
		colors: nodeColorKeys(data.nodes),
		dimensions,
		edges: Uint32Array.from(data.edges.flatMap((edge) => [Number(edge.source.slice(1)), Number(edge.target.slice(1))])),
		positions: Float32Array.from(
			data.nodes.flatMap((node) =>
				dimensions === 3
					? [node.position.x, node.position.y, node.position.z ?? 0]
					: [node.position.x, node.position.y],
			),
		),
	});
}

function manualClock() {
	let now = 0;
	let queue: ((now: number) => void)[] = [];
	return {
		frame(milliseconds: number) {
			now += milliseconds;
			const run = queue;
			queue = [];
			for (const callback of run) callback(now);
		},
		pending: () => queue.length,
		schedule(callback: (now: number) => void) {
			queue.push(callback);
			return () => {
				queue = queue.filter((entry) => entry !== callback);
			};
		},
	};
}

function random(seed: number) {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

function mount(dimensions: 2 | 3) {
	const graph = new Graphraum(new FakeElement(800, 600) as unknown as HTMLElement, {
		mode: dimensions === 3 ? "3d" : "2d",
	});
	graphs.push(graph);
	const element = Object.assign(new EventTarget(), { clientHeight: 600, clientWidth: 800 }) as unknown as HTMLElement;
	return { element, graph };
}

const cameraAt = (dimensions: 2 | 3, distance: number, x: number, y: number): GraphraumCameraState =>
	dimensions === 3
		? { mode: "3d", position: { x, y, z: distance }, target: { x, y, z: 0 } }
		: { center: { x, y }, mode: "2d", visibleHeight: distance };

/** The size and place of every node the graph draws, by id. */
const looksOf = (graph: Graphraum) =>
	new Map(
		(graph as unknown as { data: { nodes: GraphraumNode[] } }).data.nodes.map((node) => [
			node.id,
			`${node.size?.toFixed(3)}@${node.position.x.toFixed(2)},${node.position.y.toFixed(2)},${(node.position.z ?? 0).toFixed(2)}`,
		]),
	);

interface Rig {
	camera: (distance: number) => GraphraumCameraState;
	clock: ReturnType<typeof manualClock>;
	data: () => GraphraumData;
	element: HTMLElement;
	graph: Graphraum;
	grow: (to: number) => void;
	lod: ClusterLodHandle;
	options: Parameters<typeof attachClusterLod>[2];
}

function rig(dimensions: 2 | 3, seed: number, updateMilliseconds: number): Rig {
	const rand = random(seed);
	const { element, graph } = mount(dimensions);
	const clock = manualClock();
	let data = fixture(1500, dimensions);
	graph.setCameraState(cameraAt(dimensions, dimensions === 3 ? 2500 : 900, 400, 300));
	const options = {
		element,
		fit: false,
		labels: false,
		maxDrawnEdges: 800,
		maxDrawnNodes: 1500,
		pixelThreshold: 40,
		prefersReducedMotion: () => false,
		schedule: clock.schedule,
		updateMilliseconds,
	};
	const lod = attachClusterLod(graph, treeOf(data, dimensions), { ...options, data });
	return {
		camera: (distance) => cameraAt(dimensions, distance, rand() * 400, rand() * 400),
		clock,
		data: () => data,
		element,
		graph,
		grow(to) {
			data = fixture(to, dimensions);
			lod.update(treeOf(data, dimensions), { data });
		},
		lod,
		options,
	};
}

/** What a fresh layer draws for the data and camera of `context`: the look every node must settle into. */
function restingLook(context: Rig, dimensions: 2 | 3) {
	const reference = mount(dimensions);
	reference.graph.setCameraState(context.graph.getCameraState());
	const data = context.data();
	attachClusterLod(reference.graph, treeOf(data, dimensions), {
		...context.options,
		data,
		prefersReducedMotion: () => true,
	}).refresh();
	return looksOf(reference.graph);
}

function settle(clock: Rig["clock"]) {
	for (let guard = 0; guard < 200 && clock.pending() > 0; guard += 1) clock.frame(100);
	expect(clock.pending()).toBe(0);
}

function expectResting(context: Rig, dimensions: 2 | 3) {
	const expected = restingLook(context, dimensions);
	const actual = looksOf(context.graph);
	expect([...actual].filter(([id, look]) => expected.get(id) !== look).slice(0, 3)).toEqual([]);
	expect([...expected.keys()].filter((id) => !actual.has(id)).slice(0, 3)).toEqual([]);
	expect([...actual.keys()].filter((id) => !expected.has(id)).slice(0, 3)).toEqual([]);
}

describe.each([2, 3] as const)("cluster LOD after the tree grew (%dD)", (dimensions) => {
	test("a rebuilt tree that gives an old cluster id to another cluster draws the new cluster", () => {
		const context = rig(dimensions, 1, 0);
		context.grow(3000);
		context.grow(6000);
		settle(context.clock);
		expectResting(context, dimensions);
	});

	test.each(Array.from({ length: 40 }, (_, index) => index + 1))(
		"every node settles into its resting look after interleaved growth, camera moves and frames (seed %d)",
		(seed) => {
			const rand = random(seed * 7919);
			const context = rig(dimensions, seed, 600);
			let count = 1500;
			for (let step = 0; step < 40; step += 1) {
				const action = rand();
				if (action < 0.25 && count < TOTAL) {
					count = Math.min(TOTAL, count + 300 + Math.floor(rand() * 600));
					context.grow(count);
				} else if (action < 0.6) {
					context.graph.setCameraState(context.camera(dimensions === 3 ? 30 + rand() * 600 : 20 + rand() * 600));
					(context.graph as unknown as { renderFrame(): void }).renderFrame();
				} else if (action < 0.65) {
					context.lod.refresh();
				} else {
					context.clock.frame(5 + rand() * 200);
				}
			}
			settle(context.clock);
			expectResting(context, dimensions);
		},
	);
});
