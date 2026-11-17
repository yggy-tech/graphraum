import type { InstancedMesh, OrthographicCamera, ShaderMaterial } from "three";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	const { FakeWebGLRenderer } = await import("./test-support/fake-webgl");
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

import type { Graphraum } from "./graphraum";
import { createGraph, destroyGraphs, internals, mixedFixture } from "./test-support/edge-harness";
import { installFakeBrowserGlobals } from "./test-support/fake-webgl";
import type { GraphraumData, GraphraumEdge, GraphraumOptions } from "./types";

beforeAll(() => installFakeBrowserGlobals((name, value) => vi.stubGlobal(name, value)));
afterEach(() => destroyGraphs());

interface Inner {
	camera: OrthographicCamera;
	farLook: {
		mesh: (InstancedMesh & { material: ShaderMaterial }) | null;
		uniforms: Record<string, { value: unknown }>;
	};
	handleViewChange(): void;
	nodeMesh: InstancedMesh;
	renderFrame(): void;
	visibleEdgeLayouts: Map<number, unknown>;
	visibleNodeIndices: readonly number[];
}

const inner = (graph: Graphraum) => internals(graph) as unknown as Inner & ReturnType<typeof internals>;

/** The view fitted to the graph, then framed `factor` times wider by the wheel (zoom) or by a fit (frustum). */
function framed(options: GraphraumOptions, data: GraphraumData, factor: number) {
	const byZoom = createGraph({ mode: "2d", ...options });
	const byFit = createGraph({ mode: "2d", ...options });
	byZoom.setData(data);
	byFit.setData(data);
	const { visibleHeight, center } = byZoom.getCameraState() as {
		center: { x: number; y: number };
		visibleHeight: number;
	};
	const camera = inner(byZoom).camera;
	camera.zoom = 1 / factor;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();
	inner(byZoom).handleViewChange();
	byFit.setCameraState({ center, mode: "2d", visibleHeight: visibleHeight * factor });
	return { byFit, byZoom };
}

const visibleIds = (graph: Graphraum) =>
	inner(graph)
		.visibleNodeIndices.map((index: number) => inner(graph).data.nodes[index]?.id)
		.sort();

describe("one on-screen scale for fit and zoom", () => {
	test.each([0.2, 1, 4])("a view %s times the fitted height has one scale and one visible set either way", (factor) => {
		const data = mixedFixture(900, 1200, 4);
		for (const options of [{}, { maxVisibleNodes: 300 }, { maxVisibleEdges: 200, maxVisibleNodes: 300 }]) {
			const { byFit, byZoom } = framed(options, data, factor);
			expect(byZoom.getWorldUnitsPerPixel()).toBeCloseTo(byFit.getWorldUnitsPerPixel(), 9);
			expect(visibleIds(byZoom)).toEqual(visibleIds(byFit));
			expect(byZoom.getDiagnostics()).toMatchObject({
				lodLevel: byFit.getDiagnostics().lodLevel,
				visibleEdges: byFit.getDiagnostics().visibleEdges,
				visibleNodes: byFit.getDiagnostics().visibleNodes,
			});
		}
	});

	test("the far look uniforms agree between the two paths", () => {
		const { byFit, byZoom } = framed({}, mixedFixture(200, 100, 2), 6);
		for (const graph of [byFit, byZoom]) inner(graph).renderFrame();
		const read = (graph: Graphraum) => {
			const { uniforms } = inner(graph).farLook;
			return [uniforms.graphraumWorldPerPixel?.value, uniforms.graphraumFarEdge?.value];
		};
		expect(read(byZoom)[0]).toBeCloseTo(read(byFit)[0] as number, 9);
		expect(read(byZoom)[1]).toBe(read(byFit)[1]);
		expect(read(byZoom)[0]).toBeCloseTo(byZoom.getWorldUnitsPerPixel(), 9);
	});

	test("density clusters never draw under the pixel floor, however far out the camera is", () => {
		const data = mixedFixture(900, 100, 5);
		for (const factor of [1, 8, 60]) {
			const { byZoom } = framed({ maxVisibleNodes: 100 }, data, factor);
			expect(byZoom.getDiagnostics().lodLevel).toBe("density");
			const mesh = inner(byZoom).nodeMesh;
			const unitsPerPixel = byZoom.getWorldUnitsPerPixel();
			expect(mesh.count).toBeGreaterThan(0);
			for (let slot = 0; slot < mesh.count; slot += 1) {
				const halfWidth = mesh.instanceMatrix.array[slot * 16] ?? 0;
				expect(halfWidth * 2, `slot ${slot} at ${factor}x`).toBeGreaterThanOrEqual(2 * unitsPerPixel * (1 - 1e-5));
			}
		}
	});
});

describe("far look draw", () => {
	const smallNodes = (count: number): GraphraumData => ({
		edges: [],
		nodes: Array.from({ length: count }, (_, index) => ({
			id: `n${index}`,
			position: { x: (index % 30) * 10, y: Math.floor(index / 30) * 10 },
			size: 4,
		})),
	});
	const inScene = (graph: Graphraum) => inner(graph).farLook.mesh?.parent != null;

	test("is out of the scene up close and in once nodes shrink on screen", () => {
		const graph = createGraph({ mode: "2d" });
		graph.setData(smallNodes(300));
		graph.setCameraState({ center: { x: 150, y: 50 }, mode: "2d", visibleHeight: 40 });
		inner(graph).renderFrame();
		expect(inScene(graph)).toBe(false);
		graph.setCameraState({ center: { x: 150, y: 50 }, mode: "2d", visibleHeight: 60_000 });
		inner(graph).renderFrame();
		expect(inScene(graph)).toBe(true);
	});

	test("fit and zoom switch it on at the same framing", () => {
		const { byFit, byZoom } = framed({}, smallNodes(300), 400);
		for (const graph of [byFit, byZoom]) inner(graph).renderFrame();
		expect(inScene(byZoom)).toBe(true);
		expect(inScene(byFit)).toBe(true);
	});

	test("shares the node buffers, so it costs no per-node work", () => {
		const graph = createGraph({ mode: "2d" });
		graph.setData(smallNodes(50));
		graph.setCameraState({ center: { x: 150, y: 50 }, mode: "2d", visibleHeight: 60_000 });
		inner(graph).renderFrame();
		const halo = inner(graph).farLook.mesh;
		expect(halo?.instanceMatrix).toBe(inner(graph).nodeMesh.instanceMatrix);
		expect(halo?.instanceColor).toBe(inner(graph).nodeMesh.instanceColor);
		expect(halo?.count).toBe(inner(graph).nodeMesh.count);
	});

	test("adds light on dark backgrounds and multiplies on light ones", () => {
		for (const [theme, multiply] of [
			["dark", false],
			["light", true],
		] as const) {
			const graph = createGraph({ mode: "2d", theme });
			graph.setData(smallNodes(50));
			graph.setCameraState({ center: { x: 150, y: 50 }, mode: "2d", visibleHeight: 60_000 });
			inner(graph).renderFrame();
			const material = inner(graph).farLook.mesh?.material;
			expect("GRAPHRAUM_FAR_MULTIPLY" in (material?.defines ?? {})).toBe(multiply);
			expect(inner(graph).farLook.uniforms.graphraumFarMute?.value).toBe(multiply ? 0.3 : 0);
			expect(inner(graph).farLook.uniforms.graphraumFarStrength?.value).toBe(0.2);
		}
	});

	test("can be turned off and on", () => {
		const graph = createGraph({ farLook: false, mode: "2d" });
		graph.setData(smallNodes(50));
		graph.setCameraState({ center: { x: 150, y: 50 }, mode: "2d", visibleHeight: 60_000 });
		inner(graph).renderFrame();
		expect(inScene(graph)).toBe(false);
		graph.setFarLook({});
		inner(graph).renderFrame();
		expect(inScene(graph)).toBe(true);
		expect(() => graph.setFarLook({ strength: 3 })).toThrow(/strength/);
	});

	test("a focus lens alone does not bring the halo in up close", () => {
		const graph = createGraph({ focusLens: { enabled: true }, mode: "2d" });
		graph.setData(smallNodes(300));
		graph.setCameraState({ center: { x: 150, y: 50 }, mode: "2d", visibleHeight: 40 });
		inner(graph).renderFrame();
		expect(inScene(graph)).toBe(false);
	});

	test("stays off in 3D", () => {
		const graph = createGraph({ mode: "3d" });
		graph.setData(smallNodes(50));
		inner(graph).renderFrame();
		expect(inScene(graph)).toBe(false);
	});
});

describe("edges of a selected node are never culled", () => {
	/** A grid in view, one node far outside it, and a selected edge with both ends outside. */
	function fixture(): GraphraumData {
		const nodes = Array.from({ length: 400 }, (_, index) => ({
			id: `n${index}`,
			position: { x: (index % 20) * 10 - 100, y: Math.floor(index / 20) * 10 - 100 },
		}));
		nodes.push({ id: "far", position: { x: 5000, y: 0 } }, { id: "far2", position: { x: 5000, y: 100 } });
		const edges: GraphraumEdge[] = [
			{ id: "to-far", source: "n210", target: "far" },
			{ id: "both-far", source: "far", target: "far2" },
		];
		for (let index = 0; index < 399; index += 1)
			edges.push({ id: `e${index}`, source: `n${index}`, target: `n${index + 1}` });
		return { edges, nodes };
	}

	test.each<[string, GraphraumOptions]>([
		["no budget", {}],
		["edge budget", { maxVisibleEdges: 50 }],
		["density tier", { maxVisibleNodes: 100 }],
		["density tier and edge budget", { maxVisibleEdges: 50, maxVisibleNodes: 100 }],
	])("%s", (_name, options) => {
		const graph = createGraph({ mode: "2d", ...options });
		graph.setData(fixture());
		graph.setCameraState({ center: { x: 0, y: 0 }, mode: "2d", visibleHeight: 250 });
		graph.setNodeState("selected", ["n210"]);
		graph.setEdgeSelection(["both-far"]);
		const { data, visibleEdgeLayouts } = inner(graph);
		const drawn = (id: string) => visibleEdgeLayouts.has(data.edges.findIndex((edge) => edge.id === id));
		expect(drawn("to-far")).toBe(true);
		expect(drawn("both-far")).toBe(true);
		// Deselecting hands the budget back.
		graph.setNodeState("selected", []);
		graph.setEdgeSelection([]);
		if (options.maxVisibleEdges !== undefined || options.maxVisibleNodes !== undefined) {
			expect(drawn("both-far")).toBe(false);
		}
	});

	test("a selected node in view keeps its off-screen edge while the camera pans", () => {
		const graph = createGraph({ mode: "2d" });
		graph.setData(fixture());
		graph.setCameraState({ center: { x: 0, y: 0 }, mode: "2d", visibleHeight: 250 });
		graph.setNodeState("selected", ["n210"]);
		for (const x of [10, 30, 60, 0]) {
			const camera = inner(graph).camera;
			camera.position.x = x;
			camera.updateMatrixWorld();
			inner(graph).handleViewChange();
			const { data, visibleEdgeLayouts } = inner(graph);
			expect(visibleEdgeLayouts.has(data.edges.findIndex((edge) => edge.id === "to-far"))).toBe(true);
		}
	});
});
