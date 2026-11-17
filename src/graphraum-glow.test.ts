import {
	AdditiveBlending,
	InstancedMesh,
	Mesh,
	NormalBlending,
	type Object3D,
	type Scene,
	ShaderMaterial,
} from "three";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Graphraum } from "./graphraum";
import { OUTPUT_COLOR_SPACE_FRAGMENT } from "./shader-output";
import type { GraphraumData, GraphraumMode, GraphraumOptions } from "./types";

interface FakeRenderer {
	readonly info: { render: { calls: number } };
	scene: Scene | null;
}

const fakes = vi.hoisted(() => ({ renderer: null as FakeRenderer | null }));

vi.mock("three", async (importOriginal) => {
	const three = await importOriginal<typeof import("three")>();
	/**
	 * Headless WebGL stand-in. `render` counts one draw call per visible instanced mesh with at
	 * least one instance, matching Three.js (`renderInstances` skips `primcount === 0`).
	 */
	class HeadlessRenderer implements FakeRenderer {
		readonly domElement = {
			addEventListener: () => {},
			clientHeight: 600,
			clientWidth: 800,
			getBoundingClientRect: () => ({ height: 600, left: 0, top: 0, width: 800 }),
			remove: () => {},
			removeEventListener: () => {},
			style: {},
		};
		readonly info = { memory: { geometries: 0, textures: 0 }, render: { calls: 0 } };
		scene: Scene | null = null;

		constructor() {
			fakes.renderer = this;
		}

		dispose() {}
		getContext() {
			return {};
		}
		render(scene: Scene) {
			this.scene = scene;
			let calls = 0;
			scene.traverseVisible((object: Object3D) => {
				if (object instanceof three.InstancedMesh && object.count > 0) calls += 1;
			});
			this.info.render.calls = calls;
		}
		setClearColor() {}
		setPixelRatio() {}
		setSize() {}
	}
	return { ...three, WebGLRenderer: HeadlessRenderer };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", async () => {
	const { Vector3 } = await import("three");
	class HeadlessControls {
		readonly mouseButtons: Record<string, number> = {};
		readonly touches: Record<string, number> = {};
		readonly target = new Vector3();
		enableDamping = true;
		enableRotate = true;
		minZoom = 0;
		screenSpacePanning = false;
		addEventListener() {}
		dispose() {}
		removeEventListener() {}
		update() {}
	}
	return { OrbitControls: HeadlessControls };
});

let frames: FrameRequestCallback[] = [];

function flushFrames() {
	const pending = frames;
	frames = [];
	for (const frame of pending) frame(0);
}

function renderer(): FakeRenderer {
	const current = fakes.renderer;
	if (!current) throw new Error("renderer not constructed");
	return current;
}

function glowMesh(): InstancedMesh | undefined {
	const scene = renderer().scene;
	return scene?.children.find(
		(child): child is InstancedMesh => child instanceof InstancedMesh && child.name === "graphraum-node-glow",
	);
}

function createGraph(mode: GraphraumMode = "2d", options: GraphraumOptions = {}) {
	const container = { append: () => {}, clientHeight: 600, clientWidth: 800 } as unknown as HTMLElement;
	// These tests count draw calls of the hub halos alone; the far look has its own tests.
	return new Graphraum(container, { farLook: false, ...options, mode });
}

/** Moves nodes far outside the fitted 2D viewport so they stop being density candidates. */
function moveOffscreen(ids: readonly string[]) {
	return ids.map((id, index) => ({ id, position: { x: 1_000_000 + index * 10, y: 1_000_000 } }));
}

function graphData(glow: readonly (number | undefined)[]): GraphraumData {
	return {
		edges: glow.length > 1 ? [{ id: "e", source: "n0", target: "n1" }] : [],
		nodes: glow.map((value, index) => ({
			id: `n${index}`,
			position: { x: index * 10, y: 0 },
			...(value === undefined ? {} : { glow: value }),
		})),
	};
}

beforeEach(() => {
	frames = [];
	vi.stubGlobal("window", { devicePixelRatio: 1 });
	vi.stubGlobal(
		"ResizeObserver",
		class {
			disconnect() {}
			observe() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
	vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	fakes.renderer = null;
});

describe("Graphraum node glow", () => {
	test.each(["2d", "3d"] as const)("keeps two draw calls without glow in %s", (mode) => {
		const graph = createGraph(mode);
		graph.setData(graphData([undefined, 0, undefined]));
		flushFrames();
		const diagnostics = graph.getDiagnostics();
		expect(diagnostics.gpuDrawCalls).toBe(2);
		expect(diagnostics.visibleGlowNodes).toBe(0);
		expect(glowMesh()).toBeUndefined();
		graph.destroy();
	});

	test.each(["2d", "3d"] as const)("adds exactly one draw call for glowing nodes in %s", (mode) => {
		const graph = createGraph(mode);
		graph.setData(graphData([1, 0.5, 0]));
		flushFrames();
		const diagnostics = graph.getDiagnostics();
		expect(diagnostics.gpuDrawCalls).toBe(3);
		expect(diagnostics.visibleGlowNodes).toBe(2);
		graph.destroy();
	});

	test.each(["2d", "3d"] as const)("renders halos behind edges and nodes without writing depth in %s", (mode) => {
		const graph = createGraph(mode);
		graph.setData(graphData([1, 0]));
		flushFrames();
		const mesh = glowMesh();
		expect(mesh).toBeDefined();
		const others = renderer().scene?.children.filter((child) => child instanceof InstancedMesh && child !== mesh);
		expect(others).toHaveLength(2);
		for (const other of others ?? []) expect(mesh?.renderOrder).toBeLessThan(other.renderOrder);
		expect(mesh?.material).toMatchObject({ depthTest: false, depthWrite: false, transparent: true });
		graph.destroy();
	});

	test("updateNodes toggles glow on and off", () => {
		const graph = createGraph();
		graph.setData(graphData([undefined, undefined]));
		flushFrames();
		expect(graph.getDiagnostics().gpuDrawCalls).toBe(2);

		graph.updateNodes([{ id: "n1", glow: 0.8 }]);
		flushFrames();
		expect(graph.getDiagnostics()).toMatchObject({ gpuDrawCalls: 3, visibleGlowNodes: 1 });

		graph.updateNodes([{ id: "n1", glow: 0 }]);
		flushFrames();
		expect(graph.getDiagnostics()).toMatchObject({ gpuDrawCalls: 2, visibleGlowNodes: 0 });
		graph.destroy();
	});

	test("moves halos with node position updates and scales them by glow", () => {
		const graph = createGraph();
		graph.setData(graphData([1]));
		flushFrames();
		graph.updateNodes([{ id: "n0", position: { x: 5, y: 7 } }]);
		const elements = glowMesh()?.instanceMatrix.array;
		// Default node half-extent is 4 world units, so glow 1 yields a radius of 4 × 3.4.
		expect(elements?.[0]).toBeCloseTo(13.6);
		expect([elements?.[12], elements?.[13]]).toEqual([5, 7]);
		graph.destroy();
	});

	test("applyDataPatch adds glowing nodes to the halo pass", () => {
		const graph = createGraph();
		graph.setData(graphData([undefined, undefined]));
		flushFrames();
		graph.applyDataPatch({ addedNodes: [{ glow: 0.3, id: "n2", position: { x: 20, y: 0 } }] });
		flushFrames();
		expect(graph.getDiagnostics()).toMatchObject({ gpuDrawCalls: 3, visibleGlowNodes: 1 });
		graph.applyDataPatch({ removedNodeIds: ["n2"] });
		flushFrames();
		expect(graph.getDiagnostics()).toMatchObject({ gpuDrawCalls: 2, visibleGlowNodes: 0 });
		graph.destroy();
	});

	test("keeps halo color in sync with node state colors", () => {
		const graph = createGraph();
		graph.setData(graphData([1]));
		flushFrames();
		const mesh = glowMesh();
		const before = [...(mesh?.instanceColor?.array.slice(0, 3) ?? [])];
		graph.setSelection(["n0"]);
		flushFrames();
		const after = [...(mesh?.instanceColor?.array.slice(0, 3) ?? [])];
		expect(after).not.toEqual(before);
		graph.destroy();
	});

	test("disposes the glow mesh on topology rebuild and destroy", () => {
		const graph = createGraph();
		graph.setData(graphData([1]));
		flushFrames();
		const first = glowMesh();
		if (!first) throw new Error("expected a glow mesh");
		const firstGeometry = vi.spyOn(first.geometry, "dispose");
		const firstMesh = vi.spyOn(first, "dispose");
		graph.setData(graphData([undefined]));
		flushFrames();
		expect(firstGeometry).toHaveBeenCalledOnce();
		expect(firstMesh).toHaveBeenCalledOnce();
		expect(glowMesh()).toBeUndefined();

		graph.setData(graphData([0.4]));
		flushFrames();
		const second = glowMesh();
		if (!second) throw new Error("expected a glow mesh");
		const geometry = vi.spyOn(second.geometry, "dispose");
		const material = vi.spyOn(second.material as { dispose: () => void }, "dispose");
		const mesh = vi.spyOn(second, "dispose");
		const scene = renderer().scene;
		graph.destroy();
		expect(geometry).toHaveBeenCalledOnce();
		expect(mesh).toHaveBeenCalledOnce();
		expect(material).toHaveBeenCalledOnce();
		expect(scene?.children.includes(second)).toBe(false);
	});

	test("skips halos in the density LOD tier and restores them after leaving it", () => {
		const graph = createGraph("2d", { maxVisibleNodes: 10 });
		graph.setData(graphData(Array.from({ length: 12 }, () => 1)));
		flushFrames();
		expect(graph.getDiagnostics()).toMatchObject({ gpuDrawCalls: 2, lodLevel: "density", visibleGlowNodes: 0 });

		graph.updateNodes(moveOffscreen(["n8", "n9", "n10", "n11"]));
		flushFrames();
		expect(graph.getDiagnostics()).toMatchObject({ gpuDrawCalls: 3, visibleGlowNodes: 8 });
		expect(graph.getDiagnostics().lodLevel).not.toBe("density");
		graph.destroy();
	});

	test("turns glow on in a mixed position and glow batch that leaves density LOD", () => {
		const graph = createGraph("2d", { maxVisibleNodes: 10 });
		graph.setData(graphData(Array.from({ length: 12 }, () => undefined)));
		flushFrames();
		expect(graph.getDiagnostics().lodLevel).toBe("density");

		graph.updateNodes([...moveOffscreen(["n8", "n9", "n10", "n11"]), { id: "n0", glow: 1 }]);
		flushFrames();
		expect(graph.getDiagnostics().lodLevel).not.toBe("density");
		expect(graph.getDiagnostics()).toMatchObject({ gpuDrawCalls: 3, visibleGlowNodes: 1 });
		graph.destroy();
	});

	test("blends additively on dark backgrounds and normally on light ones", () => {
		const graph = createGraph();
		graph.setData(graphData([1]));
		flushFrames();
		const material = () => glowMesh()?.material as ShaderMaterial | undefined;
		expect(material()?.blending).toBe(AdditiveBlending);

		graph.setTheme("light");
		expect(material()?.blending).toBe(NormalBlending);
		expect(material()?.uniforms.opacityScale?.value).toBe(0.6);

		graph.setTheme("dark");
		expect(material()?.blending).toBe(AdditiveBlending);
		expect(material()?.uniforms.opacityScale?.value).toBe(1);

		graph.setBackground("#fcfffc");
		expect(material()?.blending).toBe(NormalBlending);
		graph.destroy();
	});

	test("creates the halo layer with light-theme blending", () => {
		const graph = createGraph("2d", { theme: "light" });
		graph.setData(graphData([1]));
		flushFrames();
		expect((glowMesh()?.material as ShaderMaterial | undefined)?.blending).toBe(NormalBlending);
		graph.destroy();
	});

	test.each(["2d", "3d"] as const)("encodes every drawn color to the output color space in %s", (mode) => {
		const graph = createGraph(mode);
		graph.setData(graphData([1, 0]));
		flushFrames();
		const drawn: Mesh[] = [];
		renderer().scene?.traverse((object) => {
			if (object instanceof Mesh) drawn.push(object);
		});
		// Nodes, edges, and halos. Node picking raycasts a mesh that is never added to the scene and
		// edge picking runs on the CPU, so no id-as-color pass exists that encoding could corrupt.
		expect(drawn).toHaveLength(3);
		for (const mesh of drawn) {
			expect(mesh.material).toBeInstanceOf(ShaderMaterial);
			const material = mesh.material as ShaderMaterial;
			expect(material.fragmentShader).toContain(OUTPUT_COLOR_SPACE_FRAGMENT);
		}
		graph.destroy();
	});
});
