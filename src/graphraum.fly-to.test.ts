import { type OrthographicCamera, type PerspectiveCamera, Spherical, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Graphraum } from "./graphraum";
import type { GraphraumData } from "./types";

/** Minimal DOM stand-ins: the engine runs in Node, so the WebGL renderer and canvas are faked. */
const fakes = vi.hoisted(() => {
	class FakeDocument extends EventTarget {
		hidden = false;
	}
	class FakeCanvas extends EventTarget {
		readonly style: Record<string, string> = {};
		readonly clientHeight = 600;
		readonly clientWidth = 800;
		ownerDocument: FakeDocument = new FakeDocument();
		readonly remove = () => undefined;
		getRootNode() {
			return this.ownerDocument;
		}
		getBoundingClientRect() {
			return { left: 0, top: 0, width: 800, height: 600 };
		}
		setPointerCapture() {}
		releasePointerCapture() {}
	}
	return { FakeCanvas };
});

vi.mock("three", async (importOriginal) => {
	const actual = await importOriginal<typeof import("three")>();
	class FakeWebGLRenderer {
		readonly domElement = new fakes.FakeCanvas();
		readonly info = { render: { calls: 0 }, memory: { geometries: 0, textures: 0 } };
		readonly render = vi.fn();
		getContext() {
			return {};
		}
		setPixelRatio() {}
		setSize() {}
		setClearColor() {}
		dispose() {}
	}
	return { ...actual, WebGLRenderer: FakeWebGLRenderer };
});

type FrameCallback = (time: number) => void;

let frames = new Map<number, FrameCallback>();
let nextFrameId = 0;

function runFrame(time: number) {
	const pending = [...frames.values()];
	frames.clear();
	for (const callback of pending) callback(time);
}

/** Runs frames from `fromMs` to `toMs` in 16 ms steps, ending exactly on `toMs`. */
function runFrames(fromMs: number, toMs: number) {
	for (let time = fromMs; time < toMs; time += 16) runFrame(time);
	runFrame(toMs);
}

/** Two clusters far apart: the flight goes from the whole graph to `c` and `d`. */
const data: GraphraumData = {
	nodes: [
		{ id: "a", position: { x: -50, y: 0, z: 0 }, size: 4 },
		{ id: "b", position: { x: 50, y: 0, z: 0 }, size: 4 },
		{ id: "c", position: { x: 2000, y: 1500, z: -40 }, size: 4 },
		{ id: "d", position: { x: 2100, y: 1540, z: 60 }, size: 4 },
	],
	edges: [{ id: "ab", source: "a", target: "b" }],
};

const graphs: Graphraum[] = [];

function setup(mode: "2d" | "3d" = "3d") {
	const container = { clientHeight: 600, clientWidth: 800, append: () => undefined } as unknown as HTMLElement;
	const graph = new Graphraum(container, { mode });
	graphs.push(graph);
	graph.setData(data);
	runFrame(0);
	return graph;
}

function cameraOf(graph: Graphraum) {
	return Reflect.get(graph, "camera") as OrthographicCamera | PerspectiveCamera;
}

interface ControlsHandle {
	target: Vector3;
	update(deltaSeconds?: number): boolean;
}

function controlsOf(graph: Graphraum) {
	return Reflect.get(graph, "controls") as ControlsHandle;
}

function canvasOf(graph: Graphraum) {
	return (Reflect.get(graph, "renderer") as { domElement: EventTarget }).domElement;
}

function viewDirection(graph: Graphraum) {
	return new Vector3().subVectors(cameraOf(graph).position, controlsOf(graph).target).normalize();
}

/** Where `fitView({ nodeIds })` puts the camera on a fresh graph with the same data. */
function fittedView(nodeIds: readonly string[], mode: "2d" | "3d" = "3d") {
	const twin = setup(mode);
	twin.fitView({ nodeIds });
	const camera = cameraOf(twin);
	return { camera, target: controlsOf(twin).target.clone() };
}

/** Records whether a promise settled and with what, without awaiting it. */
function track(promise: Promise<boolean>) {
	const state: { value: boolean | undefined } = { value: undefined };
	void promise.then((value) => {
		state.value = value;
	});
	return state;
}

beforeEach(() => {
	frames = new Map();
	nextFrameId = 0;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.stubGlobal("window", { devicePixelRatio: 1 });
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn((callback: FrameCallback) => {
			nextFrameId += 1;
			frames.set(nextFrameId, callback);
			return nextFrameId;
		}),
	);
	vi.stubGlobal(
		"cancelAnimationFrame",
		vi.fn((id: number) => {
			frames.delete(id);
		}),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});

afterEach(() => {
	for (const graph of graphs.splice(0)) graph.destroy();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Graphraum flyTo", () => {
	test("3D eases to the fitView({ nodeIds }) framing and resolves true on arrival", async () => {
		const expected = fittedView(["c", "d"]);
		const graph = setup();
		const start = controlsOf(graph).target.clone();
		const flight = track(graph.flyTo({ nodeIds: ["c", "d"], durationMs: 1000 }));

		runFrame(100);
		runFrame(600);
		// easeInOutCubic(0.5) is 0.5, so the target is halfway at half time.
		const halfway = new Vector3().lerpVectors(start, expected.target, 0.5);
		expect(controlsOf(graph).target.distanceTo(halfway)).toBeLessThan(1e-9);
		await Promise.resolve();
		expect(flight.value).toBeUndefined();

		runFrame(1100);
		await Promise.resolve();
		expect(flight.value).toBe(true);
		const camera = cameraOf(graph) as PerspectiveCamera;
		expect(controlsOf(graph).target.distanceTo(expected.target)).toBeLessThan(1e-9);
		expect(camera.position.distanceTo(expected.camera.position)).toBeLessThan(1e-6);
		expect(frames.size).toBe(0);
	});

	test("3D keeps the current view direction instead of returning to the front view", async () => {
		const expected = fittedView(["c", "d"]);
		const expectedDistance = expected.camera.position.distanceTo(expected.target);
		const graph = setup();
		const controls = controlsOf(graph);
		const camera = cameraOf(graph);
		const offset = new Spherical().setFromVector3(new Vector3().subVectors(camera.position, controls.target));
		offset.theta += 0.8;
		offset.phi -= 0.3;
		camera.position.copy(controls.target).add(new Vector3().setFromSpherical(offset));
		controls.update();
		const direction = viewDirection(graph);

		const flight = graph.flyTo({ nodeIds: ["c", "d"], durationMs: 500, distanceScale: 1.5 });
		runFrame(0);
		runFrame(250);
		expect(viewDirection(graph).distanceTo(direction)).toBeLessThan(1e-9);
		runFrame(500);
		expect(await flight).toBe(true);
		expect(viewDirection(graph).distanceTo(direction)).toBeLessThan(1e-9);
		expect(controls.target.distanceTo(expected.target)).toBeLessThan(1e-9);
		expect(camera.position.distanceTo(controls.target)).toBeCloseTo(expectedDistance * 1.5, 6);
	});

	test("3D keeps near and far valid while flying and the rest of the graph inside far on arrival", async () => {
		const graph = setup();
		const flight = graph.flyTo({ nodeIds: ["a"], durationMs: 300 });
		const camera = cameraOf(graph) as PerspectiveCamera;
		const depths = () => {
			camera.updateMatrixWorld();
			return data.nodes.map(
				(node) =>
					-new Vector3(node.position.x, node.position.y, node.position.z ?? 0).applyMatrix4(camera.matrixWorldInverse)
						.z,
			);
		};
		runFrame(0);
		runFrame(150);
		for (const depth of depths()) {
			expect(depth).toBeGreaterThan(camera.near);
			expect(depth).toBeLessThan(camera.far);
		}
		runFrame(300);
		expect(await flight).toBe(true);
		const [framed, ...rest] = depths();
		expect(framed).toBeGreaterThan(camera.near);
		expect(framed).toBeLessThan(camera.far);
		// Node d sits behind the close camera; every node in front of it stays inside the far plane.
		for (const depth of rest.filter((value) => value > 0)) expect(depth).toBeLessThan(camera.far);
	});

	test("fires view listeners every flight frame without repacking 3D instances", async () => {
		const materialize = vi.spyOn(
			Graphraum.prototype as unknown as { materializeViewport: () => void },
			"materializeViewport",
		);
		const graph = setup();
		const listener = vi.fn();
		graph.onViewChange(listener);
		listener.mockClear();
		materialize.mockClear();

		const flight = graph.flyTo({ nodeIds: ["c", "d"], durationMs: 160 });
		runFrames(0, 144);
		expect(listener).toHaveBeenCalledTimes(10);
		expect(materialize).not.toHaveBeenCalled();
		runFrame(160);
		expect(await flight).toBe(true);
		expect(materialize).toHaveBeenCalledTimes(1);
		materialize.mockRestore();
	});

	test.each(["wheel", "pointerdown", "keydown"])("a %s on the canvas cancels the flight where it is", async (type) => {
		const graph = setup();
		const flight = graph.flyTo({ nodeIds: ["c", "d"], durationMs: 1000 });
		runFrame(0);
		runFrame(300);
		// The fields OrbitControls reads, so its own handler runs as it would for real input.
		const input = {
			button: 0,
			clientX: 10,
			clientY: 10,
			deltaMode: 0,
			deltaY: 100,
			pointerId: 1,
			pointerType: "mouse",
		};
		canvasOf(graph).dispatchEvent(Object.assign(new Event(type), input));
		expect(await flight).toBe(false);
		const position = cameraOf(graph).position.clone();
		runFrames(316, 1200);
		expect(cameraOf(graph).position.toArray()).toEqual(position.toArray());
	});

	test("a second flyTo cancels the first and flies on from where the camera is", async () => {
		const expected = fittedView(["a", "b"]);
		const graph = setup();
		const first = graph.flyTo({ nodeIds: ["c", "d"], durationMs: 1000 });
		runFrame(0);
		runFrame(400);
		const second = graph.flyTo({ nodeIds: ["a", "b"], durationMs: 200 });
		expect(await first).toBe(false);
		runFrame(416);
		runFrame(616);
		expect(await second).toBe(true);
		expect(controlsOf(graph).target.distanceTo(expected.target)).toBeLessThan(1e-9);
	});

	test("fitView, setMode and destroy cancel a running flight", async () => {
		const graph = setup();
		const fit = graph.flyTo({ nodeIds: ["c"], durationMs: 1000 });
		graph.fitView();
		expect(await fit).toBe(false);

		const mode = graph.flyTo({ nodeIds: ["c"], durationMs: 1000 });
		graph.setMode("2d");
		expect(await mode).toBe(false);

		const destroyed = graph.flyTo({ nodeIds: ["c"], durationMs: 1000 });
		graph.destroy();
		expect(await destroyed).toBe(false);
		expect(await graph.flyTo({ nodeIds: ["c"] })).toBe(false);
	});

	test("setData cancels a running flight, but not with fit: false", async () => {
		const expected = fittedView(["c", "d"]);
		const graph = setup();
		const cancelled = graph.flyTo({ nodeIds: ["c", "d"], durationMs: 1000 });
		graph.setData(data);
		expect(await cancelled).toBe(false);

		const arrived = track(graph.flyTo({ nodeIds: ["c", "d"], durationMs: 200 }));
		runFrame(0);
		graph.setData(data, { fit: false });
		runFrame(100);
		runFrame(200);
		await Promise.resolve();
		expect(arrived.value).toBe(true);
		expect(controlsOf(graph).target.distanceTo(expected.target)).toBeLessThan(1e-9);
	});

	test("prefers-reduced-motion and a zero duration jump to the destination", async () => {
		const expected = fittedView(["c", "d"]);
		const instant = setup();
		expect(await instant.flyTo({ nodeIds: ["c", "d"], durationMs: 0 })).toBe(true);
		expect(controlsOf(instant).target.distanceTo(expected.target)).toBeLessThan(1e-9);

		const matchMedia = vi.fn((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)" }));
		vi.stubGlobal("window", { devicePixelRatio: 1, matchMedia });
		const reduced = setup();
		expect(await reduced.flyTo({ nodeIds: ["c", "d"], durationMs: 5000 })).toBe(true);
		expect(cameraOf(reduced).position.distanceTo(expected.camera.position)).toBeLessThan(1e-6);
		expect(matchMedia).toHaveBeenCalled();
	});

	test("unknown ids are ignored and no matching node resolves false without moving", async () => {
		const expected = fittedView(["c"]);
		const graph = setup();
		const position = cameraOf(graph).position.clone();
		expect(await graph.flyTo({ nodeIds: ["nope", "missing"] })).toBe(false);
		expect(await graph.flyTo({ nodeIds: [] })).toBe(false);
		expect(cameraOf(graph).position.toArray()).toEqual(position.toArray());
		expect(frames.size).toBe(0);

		const flight = graph.flyTo({ nodeIds: ["nope", "c"], durationMs: 100 });
		runFrame(0);
		runFrame(100);
		expect(await flight).toBe(true);
		expect(controlsOf(graph).target.distanceTo(expected.target)).toBeLessThan(1e-9);
	});

	test("throws for invalid options", () => {
		const graph = setup();
		expect(() => graph.flyTo({ nodeIds: ["a"], durationMs: -1 })).toThrow(/durationMs/);
		expect(() => graph.flyTo({ nodeIds: ["a"], distanceScale: 0 })).toThrow(/distanceScale/);
	});

	test("auto-orbit turns the camera during the flight and orbits the new target after arrival", async () => {
		const expected = fittedView(["c", "d"]);
		const graph = setup();
		graph.setAutoOrbit({ speed: 1 });
		const start = viewDirection(graph);
		const flight = graph.flyTo({ nodeIds: ["c", "d"], durationMs: 480 });
		runFrames(1000, 1480);
		expect(await flight).toBe(true);
		expect(graph.getDiagnostics().autoOrbit).toBe("active");
		const controls = controlsOf(graph);
		expect(controls.target.distanceTo(expected.target)).toBeLessThan(1e-9);
		// The orbit kept turning while flying, so the flight did not freeze the camera angle.
		expect(viewDirection(graph).angleTo(start)).toBeGreaterThan(0.3);

		const camera = cameraOf(graph);
		const distance = camera.position.distanceTo(controls.target);
		const before = viewDirection(graph);
		runFrames(1496, 1800);
		expect(controls.target.distanceTo(expected.target)).toBeLessThan(1e-9);
		expect(camera.position.distanceTo(controls.target)).toBeCloseTo(distance, 6);
		expect(viewDirection(graph).angleTo(before)).toBeGreaterThan(0.2);
	});

	test("2D pans and zooms to the fitView({ nodeIds }) framing", async () => {
		const expected = fittedView(["c", "d"], "2d").camera as OrthographicCamera;
		const graph = setup("2d");
		const camera = cameraOf(graph) as OrthographicCamera;
		const startHeight = (camera.top - camera.bottom) / camera.zoom;
		const flight = graph.flyTo({ nodeIds: ["c", "d"], durationMs: 400 });
		// Switching to the destination frustum keeps the current view until the first step.
		expect((camera.top - camera.bottom) / camera.zoom).toBeCloseTo(startHeight, 9);
		runFrame(0);
		runFrame(200);
		const midHeight = (camera.top - camera.bottom) / camera.zoom;
		expect(midHeight).toBeLessThan(startHeight);
		expect(midHeight).toBeGreaterThan(expected.top - expected.bottom);
		runFrame(400);
		expect(await flight).toBe(true);
		expect([camera.left, camera.right, camera.top, camera.bottom, camera.zoom]).toEqual([
			expected.left,
			expected.right,
			expected.top,
			expected.bottom,
			1,
		]);
		expect(camera.position.distanceTo(expected.position)).toBeLessThan(1e-9);
	});
});
