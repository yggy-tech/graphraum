import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Graphraum } from "./graphraum";
import type { GraphraumData, GraphraumOptions } from "./types";

const fakes = vi.hoisted(() => ({
	directRenders: 0,
	frames: [] as { focusDistance: number; maxBlurPixels: number }[],
	passes: 0,
	disposed: 0,
	supported: true,
}));

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	class FakeWebGLRenderer {
		readonly domElement = {
			addEventListener: () => {},
			clientHeight: 600,
			clientWidth: 800,
			getBoundingClientRect: () => ({ height: 600, left: 0, top: 0, width: 800 }),
			getRootNode: () => ({ addEventListener: () => {}, removeEventListener: () => {} }),
			ownerDocument: { addEventListener: () => {}, removeEventListener: () => {} },
			remove: () => {},
			removeEventListener: () => {},
			style: {},
		};
		readonly info = { autoReset: true, memory: { geometries: 0, textures: 0 }, render: { calls: 0 }, reset() {} };
		dispose() {}
		getContext() {
			return {};
		}
		getPixelRatio() {
			return 2;
		}
		render() {
			fakes.directRenders += 1;
		}
		setClearColor() {}
		setPixelRatio() {}
		setSize() {}
	}
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

vi.mock("./depth-of-field-pass", () => ({
	DepthOfFieldPass: class {
		static isSupported() {
			return fakes.supported;
		}
		constructor() {
			fakes.passes += 1;
		}
		dispose() {
			fakes.disposed += 1;
		}
		render(_renderer: unknown, _scene: unknown, _camera: unknown, _edges: unknown, frame: (typeof fakes.frames)[0]) {
			fakes.frames.push({ ...frame });
		}
	},
}));

let frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let reducedMotion = false;

function runFrame(time = 0) {
	const pending = [...frameCallbacks.values()];
	frameCallbacks = new Map();
	for (const callback of pending) callback(time);
}

const data: GraphraumData = {
	edges: [{ id: "a-b", source: "a", target: "b" }],
	nodes: [
		{ id: "a", position: { x: 0, y: 0, z: 0 } },
		{ id: "b", position: { x: 100, y: 0, z: -200 } },
	],
};

function createGraph(options: GraphraumOptions = {}) {
	const container = { append: () => {}, clientHeight: 600, clientWidth: 800 } as unknown as HTMLElement;
	const graph = new Graphraum(container, { mode: "3d", ...options });
	graph.setData(data);
	runFrame();
	fakes.frames = [];
	fakes.directRenders = 0;
	return graph;
}

/** Camera distance of a node, read through the public projection so the test does not reach into private state. */
function cameraDistanceTo(graph: Graphraum, nodeId: string) {
	const camera = (graph as unknown as { camera: import("three").PerspectiveCamera }).camera;
	camera.updateMatrixWorld();
	const node = data.nodes.find(({ id }) => id === nodeId);
	if (!node) throw new Error(nodeId);
	const { x, y, z = 0 } = node.position;
	const elements = camera.matrixWorldInverse.elements;
	return -((elements[2] ?? 0) * x + (elements[6] ?? 0) * y + (elements[10] ?? 0) * z + (elements[14] ?? 0));
}

beforeEach(() => {
	fakes.frames = [];
	fakes.directRenders = 0;
	fakes.passes = 0;
	fakes.disposed = 0;
	fakes.supported = true;
	reducedMotion = false;
	vi.stubGlobal("window", {
		devicePixelRatio: 1,
		matchMedia: () => ({ matches: reducedMotion }),
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			disconnect() {}
			observe() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		nextFrame += 1;
		frameCallbacks.set(nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frameCallbacks.delete(id));
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => {
		now += 50;
		return now;
	});
});

afterEach(() => {
	frameCallbacks = new Map();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("depth of field", () => {
	test("is off by default and renders each frame directly", () => {
		const graph = createGraph();
		graph.setSelection(["a"]);
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("off");
		expect(fakes.directRenders).toBe(1);
		expect(fakes.passes).toBe(0);
	});

	test("stays inactive with nothing selected", () => {
		const graph = createGraph({ depthOfField: { enabled: true } });
		graph.render();
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("inactive");
		expect(fakes.passes).toBe(0);
		expect(fakes.directRenders).toBe(1);
	});

	test("focuses the selected node's camera distance at the configured strength", () => {
		const graph = createGraph({ depthOfField: { enabled: true, strength: 0.5, transitionMs: 0 } });
		graph.setSelection(["b"]);
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("active");
		expect(fakes.directRenders).toBe(0);
		const frame = fakes.frames.at(-1);
		expect(frame?.focusDistance).toBeCloseTo(cameraDistanceTo(graph, "b"));
		// 0.5 strength × 12 CSS px × pixel ratio 2.
		expect(frame?.maxBlurPixels).toBeCloseTo(12);
	});

	test("animates the fade-in after a selection and stops requesting frames once settled", () => {
		const graph = createGraph({ depthOfField: { enabled: true, transitionMs: 400 } });
		graph.setSelection(["a"]);
		let frames = 0;
		while (frameCallbacks.size > 0 && frames < 100) {
			runFrame();
			frames += 1;
		}
		expect(frames).toBeGreaterThan(2);
		expect(frames).toBeLessThan(100);
		const blur = fakes.frames.map(({ maxBlurPixels }) => maxBlurPixels);
		expect(blur.at(-1)).toBeCloseTo(12);
		expect(blur[0]).toBeLessThan(blur.at(-1) ?? 0);
	});

	test("jumps with prefers-reduced-motion", () => {
		reducedMotion = true;
		const graph = createGraph({ depthOfField: { enabled: true, transitionMs: 400 } });
		graph.setSelection(["a"]);
		runFrame();
		expect(fakes.frames.at(-1)?.maxBlurPixels).toBeCloseTo(12);
		expect(frameCallbacks.size).toBe(0);
	});

	test("a fixed focus distance blurs without a selection", () => {
		const graph = createGraph({ depthOfField: { enabled: true, focus: 300, strength: 1 } });
		graph.render();
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("active");
		expect(fakes.frames.at(-1)).toEqual({ focusDistance: 300, maxBlurPixels: 24 });
	});

	test("is a no-op in 2D", () => {
		const graph = createGraph({ depthOfField: { enabled: true, focus: 300 }, mode: "2d" });
		graph.setSelection(["a"]);
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("inactive");
		expect(fakes.passes).toBe(0);
		expect(fakes.directRenders).toBe(1);
	});

	test("setDepthOfField toggles at runtime and releases the pass when disabled", () => {
		const graph = createGraph();
		graph.setSelection(["a"]);
		graph.setDepthOfField({ enabled: true, transitionMs: 0 });
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("active");
		graph.setDepthOfField({ strength: 1 });
		runFrame();
		expect(fakes.frames.at(-1)?.maxBlurPixels).toBeCloseTo(24);
		graph.setDepthOfField({ enabled: false });
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("off");
		expect(fakes.disposed).toBe(1);
		expect(fakes.directRenders).toBe(1);
	});

	test("rejects invalid options at construction and at runtime", () => {
		expect(() => createGraph({ depthOfField: { strength: 2 } })).toThrow(/strength/);
		const graph = createGraph();
		expect(() => graph.setDepthOfField({ focus: -1 })).toThrow(/focus/);
		expect(graph.getDiagnostics().depthOfField).toBe("off");
	});

	test("an unsupported context renders directly and warns once", () => {
		fakes.supported = false;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const first = createGraph({ depthOfField: { enabled: true, focus: 300 } });
		const second = createGraph({ depthOfField: { enabled: true, focus: 300 } });
		first.render();
		second.render();
		runFrame();
		expect(first.getDiagnostics().depthOfField).toBe("unsupported");
		expect(second.getDiagnostics().depthOfField).toBe("unsupported");
		expect(fakes.directRenders).toBe(2);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatch(/depth of field needs a WebGL 2 context/);
	});

	test("picking is unchanged while it blurs", () => {
		const graph = createGraph();
		const before = [graph.pick(400, 300), graph.pickHit(10, 10)];
		graph.setSelection(["a"]);
		graph.setDepthOfField({ enabled: true, transitionMs: 0 });
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("active");
		expect([graph.pick(400, 300), graph.pickHit(10, 10)]).toEqual(before);
	});
});
