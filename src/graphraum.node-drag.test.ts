import type { OrthographicCamera, PerspectiveCamera } from "three";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Graphraum } from "./graphraum";
import type { GraphraumData, GraphraumNodeDragEvent } from "./types";

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

const data: GraphraumData = {
	nodes: [
		{ id: "a", position: { x: -60, y: 10, z: 20 }, size: 8 },
		{ id: "b", position: { x: 60, y: -10, z: -20 }, size: 8 },
	],
	edges: [{ id: "ab", source: "a", target: "b" }],
};

const graphs: Graphraum[] = [];

function setup(mode: "2d" | "3d") {
	const container = { clientHeight: 600, clientWidth: 800, append: () => undefined } as unknown as HTMLElement;
	const graph = new Graphraum(container, { mode });
	graphs.push(graph);
	graph.setData(data);
	runFrame(0);
	return graph;
}

function canvasOf(graph: Graphraum) {
	return (Reflect.get(graph, "renderer") as { domElement: EventTarget }).domElement;
}

function cameraOf(graph: Graphraum) {
	return Reflect.get(graph, "camera") as OrthographicCamera | PerspectiveCamera;
}

function controlsOf(graph: Graphraum) {
	return Reflect.get(graph, "controls") as { enabled: boolean };
}

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}) {
	target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), props));
}

const mouse = { button: 0, pointerId: 1, pointerType: "mouse" };

function screenOf(graph: Graphraum, nodeId: string) {
	const position = graph.getNodeScreenPosition(nodeId);
	if (!position) throw new Error(`no screen position for ${nodeId}`);
	return position;
}

function record(graph: Graphraum) {
	const events: GraphraumNodeDragEvent[] = [];
	graph.onNodeDrag((event) => events.push(event));
	return events;
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

describe.each(["2d", "3d"] as const)("Graphraum node drag (%s)", (mode) => {
	test("is off until enabled", () => {
		const graph = setup(mode);
		const events = record(graph);
		const start = screenOf(graph, "a");
		fire(canvasOf(graph), "pointerdown", { ...mouse, clientX: start.x, clientY: start.y });
		fire(canvasOf(graph), "pointermove", { ...mouse, clientX: start.x + 80, clientY: start.y + 40 });
		expect(events).toEqual([]);
		expect(graph.getNodeScreenPosition("a")).toEqual(start);
	});

	test("the node stays under the pointer, camera and the other node do not move", () => {
		const graph = setup(mode);
		graph.setNodeDrag({ enabled: true });
		const events = record(graph);
		const camera = cameraOf(graph);
		const cameraBefore = camera.position.toArray();
		const bBefore = screenOf(graph, "b");
		const start = screenOf(graph, "a");

		// Grab 2 px right of and 1 px below the node centre, then pull it 120 px right and 45 px up.
		fire(canvasOf(graph), "pointerdown", { ...mouse, clientX: start.x + 2, clientY: start.y + 1 });
		expect(controlsOf(graph).enabled).toBe(false);
		fire(canvasOf(graph), "pointermove", { ...mouse, clientX: start.x + 2 + 120, clientY: start.y + 1 - 45 });

		const moved = screenOf(graph, "a");
		expect(moved.x).toBeCloseTo(start.x + 120, 3);
		expect(moved.y).toBeCloseTo(start.y - 45, 3);
		expect(camera.position.toArray()).toEqual(cameraBefore);
		const bAfter = screenOf(graph, "b");
		expect(bAfter.x).toBeCloseTo(bBefore.x, 6);
		expect(bAfter.y).toBeCloseTo(bBefore.y, 6);

		fire(canvasOf(graph), "pointerup", { ...mouse, clientX: start.x + 122, clientY: start.y - 44 });
		expect(controlsOf(graph).enabled).toBe(true);
		expect(events.map((event) => event.phase)).toEqual(["start", "move", "end"]);
		expect(events.every((event) => event.nodeId === "a")).toBe(true);
	});

	test("Escape puts the node back and the camera works again", () => {
		const graph = setup(mode);
		graph.setNodeDrag({ enabled: true });
		const events = record(graph);
		const start = screenOf(graph, "a");
		fire(canvasOf(graph), "pointerdown", { ...mouse, clientX: start.x, clientY: start.y });
		fire(canvasOf(graph), "pointermove", { ...mouse, clientX: start.x + 90, clientY: start.y + 30 });
		const document = (canvasOf(graph) as unknown as { ownerDocument: EventTarget }).ownerDocument;
		fire(document, "keydown", { key: "Escape" });

		const back = screenOf(graph, "a");
		expect(back.x).toBeCloseTo(start.x, 3);
		expect(back.y).toBeCloseTo(start.y, 3);
		expect(events.at(-1)?.phase).toBe("cancel");
		expect(controlsOf(graph).enabled).toBe(true);
	});

	test("replacing the data mid-drag cancels the drag without throwing", () => {
		const graph = setup(mode);
		graph.setNodeDrag({ enabled: true });
		const events = record(graph);
		const start = screenOf(graph, "a");
		fire(canvasOf(graph), "pointerdown", { ...mouse, clientX: start.x, clientY: start.y });
		fire(canvasOf(graph), "pointermove", { ...mouse, clientX: start.x + 90, clientY: start.y });
		graph.setData({ nodes: [{ id: "b", position: { x: 0, y: 0, z: 0 }, size: 8 }], edges: [] });
		fire(canvasOf(graph), "pointermove", { ...mouse, clientX: start.x + 120, clientY: start.y });

		expect(events.at(-1)?.phase).toBe("cancel");
		expect(controlsOf(graph).enabled).toBe(true);
	});

	test("an unsubscribed listener hears nothing and setNodeDrag validates its option", () => {
		const graph = setup(mode);
		graph.setNodeDrag({ enabled: true });
		const heard: GraphraumNodeDragEvent[] = [];
		const stop = graph.onNodeDrag((event) => heard.push(event));
		stop();
		const start = screenOf(graph, "a");
		fire(canvasOf(graph), "pointerdown", { ...mouse, clientX: start.x, clientY: start.y });
		fire(canvasOf(graph), "pointermove", { ...mouse, clientX: start.x + 90, clientY: start.y });
		expect(heard).toEqual([]);
		expect(() => graph.setNodeDrag({ enabled: "yes" as unknown as boolean })).toThrow(/enabled must be a boolean/);
	});
});

describe("Graphraum node drag depth", () => {
	test("in 3D the node keeps its distance from the camera plane", () => {
		const graph = setup("3d");
		graph.setNodeDrag({ enabled: true });
		const camera = cameraOf(graph);
		const forward = camera.getWorldDirection(camera.position.clone());
		const depth = () => {
			const index = (Reflect.get(graph, "nodeIndices") as Map<string, number>).get("a") ?? 0;
			const node = (Reflect.get(graph, "data") as GraphraumData).nodes[index];
			const position = node?.position;
			if (!position) throw new Error("node a is gone");
			return forward.x * position.x + forward.y * position.y + forward.z * (position.z ?? 0);
		};
		const before = depth();
		const start = screenOf(graph, "a");
		fire(canvasOf(graph), "pointerdown", { ...mouse, clientX: start.x, clientY: start.y });
		fire(canvasOf(graph), "pointermove", { ...mouse, clientX: start.x + 150, clientY: start.y - 70 });
		expect(depth()).toBeCloseTo(before, 3);
	});
});
