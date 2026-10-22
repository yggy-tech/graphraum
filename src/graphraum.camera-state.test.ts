import { type OrthographicCamera, type PerspectiveCamera, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Graphraum } from "./graphraum";
import type { GraphraumCameraState, GraphraumData } from "./types";

/** Minimal DOM stand-ins: the engine runs in Node, so the WebGL renderer and canvas are faked. */
const fakes = vi.hoisted(() => {
	class FakeDocument extends EventTarget {
		hidden = false;
	}
	class FakeCanvas extends EventTarget {
		readonly style: Record<string, string> = {};
		clientHeight = 600;
		clientWidth = 800;
		ownerDocument: FakeDocument = new FakeDocument();
		readonly remove = () => undefined;
		getRootNode() {
			return this.ownerDocument;
		}
		getBoundingClientRect() {
			return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
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

const data: GraphraumData = {
	nodes: [
		{ id: "a", position: { x: -300, y: 40, z: 20 }, size: 8 },
		{ id: "b", position: { x: 500, y: -120, z: -60 }, size: 8 },
		{ id: "c", position: { x: 40, y: 400, z: 200 }, size: 8 },
	],
	edges: [{ id: "ab", source: "a", target: "b" }],
};

const graphs: Graphraum[] = [];
let container: { append: () => undefined; clientHeight: number; clientWidth: number };

function setup(mode: "2d" | "3d", width = 800) {
	container = { append: () => undefined, clientHeight: 600, clientWidth: width };
	const graph = new Graphraum(container as unknown as HTMLElement, { mode });
	graphs.push(graph);
	graph.setData(data);
	runFrame(0);
	return graph;
}

function cameraOf(graph: Graphraum) {
	return Reflect.get(graph, "camera") as OrthographicCamera | PerspectiveCamera;
}

function controlsOf(graph: Graphraum) {
	return Reflect.get(graph, "controls") as { target: Vector3 };
}

const screenOf = (graph: Graphraum, id: string) => {
	const position = graph.getNodeScreenPosition(id);
	if (!position) throw new Error(`no screen position for ${id}`);
	return position;
};

/** Moves the camera the way a person would: pan and zoom in 2D, orbit and dolly in 3D. */
function moveCamera(graph: Graphraum) {
	const camera = cameraOf(graph);
	if (camera.type === "OrthographicCamera") {
		(camera as OrthographicCamera).zoom = 2.5;
		camera.position.x += 120;
		camera.position.y -= 70;
		controlsOf(graph).target.x += 120;
		controlsOf(graph).target.y -= 70;
		camera.updateProjectionMatrix();
	} else {
		camera.position.set(camera.position.x + 400, camera.position.y - 250, camera.position.z * 0.7);
		camera.lookAt(controlsOf(graph).target);
	}
	camera.updateMatrixWorld();
}

function expectClose(actual: GraphraumCameraState, expected: GraphraumCameraState) {
	expect(actual.mode).toBe(expected.mode);
	const flat = (state: GraphraumCameraState) =>
		state.mode === "2d"
			? [state.center.x, state.center.y, state.visibleHeight]
			: [state.position.x, state.position.y, state.position.z, state.target.x, state.target.y, state.target.z];
	const [left, right] = [flat(actual), flat(expected)];
	expect(left).toHaveLength(right.length);
	for (const [index, value] of left.entries()) expect(value).toBeCloseTo(right[index] as number, 6);
}

beforeEach(() => {
	frames = new Map();
	nextFrameId = 0;
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
	vi.unstubAllGlobals();
});

describe("getCameraState", () => {
	test("2D reports where the camera looks and how much it shows", () => {
		const graph = setup("2d");
		const camera = cameraOf(graph) as OrthographicCamera;
		const state = graph.getCameraState();
		expect(state.mode).toBe("2d");
		if (state.mode !== "2d") return;
		expect(state.center).toEqual({ x: camera.position.x, y: camera.position.y });
		expect(state.visibleHeight).toBeCloseTo((camera.top - camera.bottom) / camera.zoom, 9);

		camera.zoom = 4;
		camera.updateProjectionMatrix();
		const zoomed = graph.getCameraState();
		expect(zoomed.mode === "2d" && zoomed.visibleHeight).toBeCloseTo(state.visibleHeight / 4, 9);
	});

	test("3D reports the camera position and the point it orbits", () => {
		const graph = setup("3d");
		const state = graph.getCameraState();
		const camera = cameraOf(graph);
		expect(state).toEqual({
			mode: "3d",
			position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
			target: { x: controlsOf(graph).target.x, y: controlsOf(graph).target.y, z: controlsOf(graph).target.z },
		});
	});

	test("is plain JSON and a copy, not a live view of the camera", () => {
		const graph = setup("3d");
		const state = graph.getCameraState();
		expect(JSON.parse(JSON.stringify(state))).toEqual(state);
		if (state.mode === "3d") state.position.x += 1000;
		expect(graph.getCameraState()).not.toEqual(state);
	});
});

describe.each(["2d", "3d"] as const)("setCameraState (%s)", (mode) => {
	test("restores a saved pose: the same nodes land on the same screen points", () => {
		const graph = setup(mode);
		const saved = JSON.parse(JSON.stringify(graph.getCameraState())) as GraphraumCameraState;
		const before = ["a", "b", "c"].map((id) => screenOf(graph, id));

		moveCamera(graph);
		expect(screenOf(graph, "a").x).not.toBeCloseTo(before[0]?.x ?? 0, 1);

		graph.setCameraState(saved);
		for (const [index, id] of ["a", "b", "c"].entries()) {
			expect(screenOf(graph, id).x).toBeCloseTo(before[index]?.x ?? 0, 4);
			expect(screenOf(graph, id).y).toBeCloseTo(before[index]?.y ?? 0, 4);
		}
		expectClose(graph.getCameraState(), saved);
	});

	test("restores a moved pose exactly, not just the fitted one", () => {
		const graph = setup(mode);
		moveCamera(graph);
		const saved = graph.getCameraState();
		const before = screenOf(graph, "b");

		graph.fitView();
		graph.setCameraState(saved);

		expectClose(graph.getCameraState(), saved);
		expect(screenOf(graph, "b").x).toBeCloseTo(before.x, 4);
		expect(screenOf(graph, "b").y).toBeCloseTo(before.y, 4);
	});

	test("cancels a running flight", async () => {
		const graph = setup(mode);
		const saved = graph.getCameraState();
		const flight = graph.flyTo({ durationMs: 1000, nodeIds: ["c"] });
		graph.setCameraState(saved);
		expect(await flight).toBe(false);
	});

	test("rejects a state from the other mode and a malformed one, leaving the camera alone", () => {
		const graph = setup(mode);
		const before = graph.getCameraState();
		const other: GraphraumCameraState =
			mode === "2d"
				? { mode: "3d", position: { x: 0, y: 0, z: 100 }, target: { x: 0, y: 0, z: 0 } }
				: { center: { x: 0, y: 0 }, mode: "2d", visibleHeight: 100 };
		expect(() => graph.setCameraState(other)).toThrow(
			new RegExp(`${other.mode} camera state to a graph in ${mode} mode`),
		);
		expect(() => graph.setCameraState({ ...before, mode } as unknown as GraphraumCameraState)).not.toThrow();
		expect(() => graph.setCameraState({ mode } as unknown as GraphraumCameraState)).toThrow(/finite number/);
		expectClose(graph.getCameraState(), before);
	});

	test("fitView still frames the graph afterwards", () => {
		const graph = setup(mode);
		const fitted = graph.getCameraState();
		moveCamera(graph);
		graph.setCameraState(graph.getCameraState());
		graph.fitView();
		expectClose(graph.getCameraState(), fitted);
	});
});

describe("setCameraState in 2D", () => {
	test("a resize to the same size leaves the restored view alone", () => {
		const graph = setup("2d");
		moveCamera(graph);
		const saved = graph.getCameraState();
		graph.fitView();
		graph.setCameraState(saved);

		graph.resize();

		expectClose(graph.getCameraState(), saved);
	});

	test("a real resize still refits, as before", () => {
		const graph = setup("2d");
		const resized = container;
		moveCamera(graph);
		const expected = setup("2d", 500).getCameraState();
		resized.clientWidth = 500;

		graph.resize();

		expectClose(graph.getCameraState(), expected);
	});

	test("a view saved on one canvas keeps its height on a canvas of another shape", () => {
		const graph = setup("2d");
		moveCamera(graph);
		const saved = graph.getCameraState();
		container.clientWidth = 400;
		graph.resize();

		graph.setCameraState(saved);

		const camera = cameraOf(graph) as OrthographicCamera;
		expect(saved.mode === "2d" && (camera.top - camera.bottom) / camera.zoom).toBeCloseTo(
			saved.mode === "2d" ? saved.visibleHeight : 0,
			6,
		);
		expect((camera.right - camera.left) / (camera.top - camera.bottom)).toBeCloseTo(400 / 600, 6);
	});
});

describe("setCameraState in 3D", () => {
	test("a camera far from the graph still has the whole graph between its clip planes", () => {
		const graph = setup("3d");
		graph.setCameraState({
			mode: "3d",
			position: { x: 30_000, y: 20_000, z: 60_000 },
			target: { x: 0, y: 0, z: 0 },
		});
		const camera = cameraOf(graph) as PerspectiveCamera;
		for (const node of data.nodes) {
			const toNode = new Vector3(node.position.x, node.position.y, node.position.z ?? 0).sub(camera.position);
			expect(toNode.length()).toBeLessThan(camera.far);
			expect(toNode.length()).toBeGreaterThan(camera.near);
		}
	});

	test("flyTo keeps the restored view direction", async () => {
		const graph = setup("3d");
		const position = { x: 900, y: 500, z: 1400 };
		graph.setCameraState({ mode: "3d", position, target: { x: 0, y: 0, z: 0 } });
		const direction = new Vector3(position.x, position.y, position.z).normalize();

		await graph.flyTo({ durationMs: 0, nodeIds: ["b"] });

		const camera = cameraOf(graph);
		const after = camera.position.clone().sub(controlsOf(graph).target).normalize();
		expect(after.distanceTo(direction)).toBeLessThan(1e-9);
	});

	test("auto-orbit turns around the restored target from the restored pose", () => {
		const graph = setup("3d");
		const target = { x: 40, y: -30, z: 10 };
		const position = { x: 840, y: -30, z: 10 };
		graph.setCameraState({ mode: "3d", position, target });

		graph.setAutoOrbit({ speed: 1 });
		runFrame(0);
		runFrame(500);

		const camera = cameraOf(graph);
		expect(camera.position.x).not.toBeCloseTo(position.x, 3);
		expect(camera.position.distanceTo(controlsOf(graph).target)).toBeCloseTo(800, 3);
		expect(controlsOf(graph).target.distanceTo(new Vector3(target.x, target.y, target.z))).toBeLessThan(1e-9);
	});
});
