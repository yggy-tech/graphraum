import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Graphraum } from "./graphraum";
import type { GraphraumData, GraphraumOptions } from "./types";

const fakes = vi.hoisted(() => ({
	directRenders: 0,
	frames: [] as { aperturePixels: number; focusDistance: number; maxBlurPixels: number; minBlurPixels: number }[],
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

/** Runs frames until no more are requested, for at most `limit`. Returns how many ran. */
function settle(limit = 100) {
	let frames = 0;
	while (frameCallbacks.size > 0 && frames < limit) {
		runFrame();
		frames += 1;
	}
	return frames;
}

function cameraOf(graph: Graphraum) {
	return (graph as unknown as { camera: import("three").PerspectiveCamera }).camera;
}

const instant = { transition: { durationMs: 0 } };

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

	test("focuses the selected node's camera distance with a thin-lens aperture", () => {
		const graph = createGraph({ depthOfField: { enabled: true, strength: 0.5, ...instant } });
		graph.setSelection(["b"]);
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("active");
		expect(fakes.directRenders).toBe(0);
		const frame = fakes.frames.at(-1);
		expect(frame?.focusDistance).toBeCloseTo(cameraDistanceTo(graph, "b"));
		// 0.5 strength × 24 CSS px × pixel ratio 2; the 12 CSS px maximum × pixel ratio 2.
		expect(frame).toMatchObject({ aperturePixels: 24, maxBlurPixels: 24, minBlurPixels: 0 });
	});

	test("re-measures the focus every frame while the camera moves, without a transition", () => {
		const graph = createGraph({ depthOfField: { enabled: true, ...instant } });
		graph.setSelection(["b"]);
		runFrame();
		const before = fakes.frames.at(-1)?.focusDistance ?? 0;
		const camera = cameraOf(graph);
		camera.position.set(400, 300, -900);
		camera.lookAt(0, 0, 0);
		graph.render();
		runFrame();
		const after = fakes.frames.at(-1)?.focusDistance ?? 0;
		expect(after).toBeCloseTo(cameraDistanceTo(graph, "b"));
		expect(after).not.toBeCloseTo(before);
		expect(frameCallbacks.size).toBe(0);
	});

	test("fades the focus in after a selection with the configured easing and then stops", () => {
		const graph = createGraph({ depthOfField: { enabled: true, transition: { durationMs: 400, easing: "linear" } } });
		graph.setSelection(["a"]);
		const frames = settle();
		expect(frames).toBeGreaterThan(2);
		expect(frames).toBeLessThan(100);
		const apertures = fakes.frames.map(({ aperturePixels }) => aperturePixels);
		expect(apertures.at(-1)).toBeCloseTo(24);
		expect(apertures[0]).toBeLessThan(apertures.at(-1) ?? 0);
	});

	test("enabling and disabling fade the blur, then release the pass", async () => {
		const graph = createGraph({ depthOfField: { transition: { durationMs: 400, easing: "linear" } } });
		graph.setSelection(["a"]);
		const shown = graph.setDepthOfField({ enabled: true });
		settle();
		await expect(shown).resolves.toBe(true);
		const fadeIn = fakes.frames.map(({ aperturePixels }) => aperturePixels);
		expect(fadeIn.length).toBeGreaterThan(2);
		expect(fadeIn.every((value, index) => index === 0 || value >= (fadeIn[index - 1] ?? 0))).toBe(true);
		expect(fadeIn.at(-1)).toBeCloseTo(24);

		fakes.frames = [];
		const hidden = graph.setDepthOfField({ enabled: false });
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("active");
		settle();
		await expect(hidden).resolves.toBe(true);
		const fadeOut = fakes.frames.map(({ aperturePixels }) => aperturePixels);
		expect(fadeOut[1]).toBeLessThan(24);
		expect(fadeOut.every((value, index) => index === 0 || value <= (fadeOut[index - 1] ?? 0))).toBe(true);
		graph.render();
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("off");
		expect(fakes.disposed).toBe(1);
	});

	test("a strength change during a fade continues from the blur shown last", async () => {
		const graph = createGraph({
			depthOfField: { enabled: true, strength: 0, transition: { durationMs: 1000, easing: "linear" } },
		});
		graph.setSelection(["a"]);
		settle();
		const first = graph.setDepthOfField({ strength: 1 });
		runFrame();
		runFrame();
		runFrame();
		const shown = fakes.frames.at(-1)?.aperturePixels ?? 0;
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(48);
		const second = graph.setDepthOfField({ strength: 0.5 });
		await expect(first).resolves.toBe(false);
		runFrame();
		expect(fakes.frames.at(-1)?.aperturePixels).toBeCloseTo(shown, 0);
		settle();
		await expect(second).resolves.toBe(true);
		expect(fakes.frames.at(-1)?.aperturePixels).toBeCloseTo(24);
	});

	test("animate: false and reduced motion jump", async () => {
		const graph = createGraph({ depthOfField: { enabled: true, strength: 0.25, transition: { durationMs: 400 } } });
		graph.setSelection(["a"]);
		settle();
		await expect(graph.setDepthOfField({ strength: 1 }, { animate: false })).resolves.toBe(true);
		runFrame();
		expect(fakes.frames.at(-1)?.aperturePixels).toBeCloseTo(48);

		reducedMotion = true;
		const reduced = createGraph({ depthOfField: { enabled: true, transition: { durationMs: 400 } } });
		reduced.setSelection(["a"]);
		runFrame();
		expect(fakes.frames.at(-1)?.aperturePixels).toBeCloseTo(24);
		await expect(reduced.setDepthOfField({ strength: 1 })).resolves.toBe(true);
		runFrame();
		expect(fakes.frames.at(-1)?.aperturePixels).toBeCloseTo(48);
		expect(frameCallbacks.size).toBe(0);
	});

	test("nearDistance and farDistance fade the strength with camera-to-focus distance", () => {
		const graph = createGraph({ depthOfField: { enabled: true, ...instant } });
		graph.setSelection(["a"]);
		const distance = cameraDistanceTo(graph, "a");
		graph.setDepthOfField({ farDistance: distance * 2, nearDistance: 0 });
		runFrame();
		const halfway = fakes.frames.at(-1)?.aperturePixels ?? 0;
		expect(halfway).toBeCloseTo(12);
		graph.setDepthOfField({ farDistance: distance / 2, nearDistance: distance / 4 });
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("inactive");
		graph.setDepthOfField({ farDistance: distance * 4, nearDistance: distance * 2 });
		runFrame();
		expect(fakes.frames.at(-1)?.aperturePixels).toBeCloseTo(24);
	});

	test("minBlur and maxBlur reach the pass in device pixels", () => {
		const graph = createGraph({ depthOfField: { enabled: true, maxBlur: 8, minBlur: 1.5, ...instant } });
		graph.setSelection(["a"]);
		runFrame();
		expect(fakes.frames.at(-1)).toMatchObject({ maxBlurPixels: 16, minBlurPixels: 3 });
	});

	test("a fixed focus distance blurs without a selection", () => {
		const graph = createGraph({ depthOfField: { enabled: true, focus: 300, strength: 1 } });
		graph.render();
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("active");
		expect(fakes.frames.at(-1)).toEqual({
			aperturePixels: 48,
			focusDistance: 300,
			maxBlurPixels: 24,
			minBlurPixels: 0,
		});
	});

	test("is a no-op in 2D and settles its fade there", async () => {
		const graph = createGraph({ depthOfField: { focus: 300 }, mode: "2d" });
		graph.setSelection(["a"]);
		const done = graph.setDepthOfField({ enabled: true });
		runFrame();
		await expect(done).resolves.toBe(true);
		expect(graph.getDiagnostics().depthOfField).toBe("inactive");
		expect(fakes.passes).toBe(0);
		expect(fakes.directRenders).toBe(1);
	});

	test("rejects invalid options at construction and at runtime", () => {
		expect(() => createGraph({ depthOfField: { strength: 2 } })).toThrow(/strength/);
		const graph = createGraph();
		expect(() => graph.setDepthOfField({ focus: -1 })).toThrow(/focus/);
		expect(() => graph.setDepthOfField({}, { animate: "yes" as never })).toThrow(/animate must be a boolean/);
		expect(graph.getDiagnostics().depthOfField).toBe("off");
	});

	test("destroy interrupts a running fade", async () => {
		const graph = createGraph();
		graph.setSelection(["a"]);
		const fade = graph.setDepthOfField({ enabled: true });
		graph.destroy();
		await expect(fade).resolves.toBe(false);
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
		graph.setDepthOfField({ enabled: true }, { animate: false });
		runFrame();
		expect(graph.getDiagnostics().depthOfField).toBe("active");
		expect([graph.pick(400, 300), graph.pickHit(10, 10)]).toEqual(before);
	});
});
