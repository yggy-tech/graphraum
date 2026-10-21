import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NODE_DRAG_TOLERANCE_PX, NODE_DRAG_TOUCH_HOLD_MS, NodeDragController, type NodeDragHost } from "./node-drag";
import type { GraphraumNodeDragEvent, GraphraumPosition } from "./types";

class FakeElement extends EventTarget {
	readonly captured: number[] = [];
	readonly released: number[] = [];
	setPointerCapture(pointerId: number) {
		this.captured.push(pointerId);
	}
	releasePointerCapture(pointerId: number) {
		this.released.push(pointerId);
	}
}

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}) {
	target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), props));
}

interface Setup {
	controller: NodeDragController;
	controlsEnabled: boolean[];
	document: EventTarget;
	element: FakeElement;
	events: GraphraumNodeDragEvent[];
	host: NodeDragHost;
	nodes: Map<string, GraphraumPosition>;
}

/** A host with one node "a" at the origin whose drag surface maps a pointer 1:1 onto world units. */
function setup(options: { is3d?: boolean; startZ?: number } = {}): Setup {
	const element = new FakeElement();
	const document = new EventTarget();
	const nodes = new Map<string, GraphraumPosition>([
		["a", options.is3d || options.startZ !== undefined ? { x: 10, y: 20, z: options.startZ ?? 0 } : { x: 10, y: 20 }],
	]);
	const events: GraphraumNodeDragEvent[] = [];
	const controlsEnabled: boolean[] = [];
	const host: NodeDragHost = {
		canStart: () => true,
		createSurface: () => (clientX, clientY) =>
			options.is3d ? { x: clientX, y: clientY, z: 5 } : { x: clientX, y: clientY },
		document,
		element,
		emit: (event) => events.push(event),
		moveNode: (nodeId, position) => {
			nodes.set(nodeId, position);
		},
		nodePosition: (nodeId) => nodes.get(nodeId) ?? null,
		pickNode: (clientX, clientY) => (Math.hypot(clientX - 10, clientY - 20) < 8 ? "a" : null),
		setControlsEnabled: (enabled) => controlsEnabled.push(enabled),
	};
	const controller = new NodeDragController(host);
	controller.setEnabled(true);
	return { controller, controlsEnabled, document, element, events, host, nodes };
}

const mouse = { button: 0, pointerId: 1, pointerType: "mouse" };
const touch = { button: 0, pointerId: 7, pointerType: "touch" };

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("NodeDragController with a mouse", () => {
	test("stays out of the way until enabled", () => {
		const { controller, controlsEnabled, element, events } = setup();
		controller.setEnabled(false);
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 60, clientY: 80 });
		expect(controlsEnabled).toEqual([]);
		expect(events).toEqual([]);
	});

	test("a press on empty space does nothing", () => {
		const { controlsEnabled, element, events } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 300, clientY: 300 });
		fire(element, "pointermove", { ...mouse, clientX: 340, clientY: 340 });
		expect(controlsEnabled).toEqual([]);
		expect(events).toEqual([]);
	});

	test("a press that stays under the tolerance is a click: no events, controls restored", () => {
		const { controller, controlsEnabled, element, events, nodes } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		expect(controlsEnabled).toEqual([false]);
		fire(element, "pointermove", { ...mouse, clientX: 10 + NODE_DRAG_TOLERANCE_PX, clientY: 20 });
		fire(element, "pointerup", { ...mouse, clientX: 10, clientY: 20 });
		expect(controlsEnabled).toEqual([false, true]);
		expect(events).toEqual([]);
		expect(nodes.get("a")).toEqual({ x: 10, y: 20 });
		expect(controller.active).toBe(false);
	});

	test("moving past the tolerance starts the drag and the node follows with the grab offset", () => {
		const { controller, element, events, nodes } = setup();
		// Grab 3 units right of and 2 above the node centre.
		fire(element, "pointerdown", { ...mouse, clientX: 13, clientY: 18 });
		fire(element, "pointermove", { ...mouse, clientX: 13 + NODE_DRAG_TOLERANCE_PX + 1, clientY: 18 });
		expect(controller.active).toBe(true);
		expect(events[0]).toEqual({ nodeId: "a", phase: "start", position: { x: 10, y: 20 } });
		fire(element, "pointermove", { ...mouse, clientX: 53, clientY: 48 });
		expect(nodes.get("a")).toEqual({ x: 50, y: 50 });
		expect(events.at(-1)).toEqual({ nodeId: "a", phase: "move", position: { x: 50, y: 50 } });
	});

	test("release ends the drag at the last position and restores the controls", () => {
		const { controller, controlsEnabled, element, events } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 40, clientY: 20 });
		fire(element, "pointerup", { ...mouse, clientX: 40, clientY: 20 });
		expect(events.map((event) => event.phase)).toEqual(["start", "move", "end"]);
		expect(events.at(-1)?.position).toEqual({ x: 40, y: 20 });
		expect(controlsEnabled).toEqual([false, true]);
		expect(element.released).toEqual([1]);
		expect(controller.active).toBe(false);
	});

	test("Escape cancels the drag and puts the node back", () => {
		const { controller, controlsEnabled, document, element, events, nodes } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		fire(document, "keydown", { key: "Escape" });
		expect(nodes.get("a")).toEqual({ x: 10, y: 20 });
		expect(events.at(-1)).toEqual({ nodeId: "a", phase: "cancel", position: { x: 10, y: 20 } });
		expect(controlsEnabled).toEqual([false, true]);
		expect(controller.active).toBe(false);
		// The pointer that is still down must not move the node again.
		fire(element, "pointermove", { ...mouse, clientX: 120, clientY: 120 });
		expect(nodes.get("a")).toEqual({ x: 10, y: 20 });
	});

	test("other keys do not cancel", () => {
		const { controller, document, element } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		fire(document, "keydown", { key: "a" });
		expect(controller.active).toBe(true);
	});

	test("a cancelled pointer restores the node", () => {
		const { element, events, nodes } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		fire(element, "pointercancel", { ...mouse });
		expect(nodes.get("a")).toEqual({ x: 10, y: 20 });
		expect(events.at(-1)?.phase).toBe("cancel");
	});

	test("losing pointer capture mid-drag cancels, but our own release does not", () => {
		const first = setup();
		fire(first.element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(first.element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		fire(first.element, "lostpointercapture", { ...mouse });
		expect(first.events.at(-1)?.phase).toBe("cancel");

		const second = setup();
		fire(second.element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(second.element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		fire(second.element, "pointerup", { ...mouse });
		fire(second.element, "lostpointercapture", { ...mouse });
		expect(second.events.map((event) => event.phase)).toEqual(["start", "move", "end"]);
	});

	test("ignores secondary buttons and a second pointer while one gesture runs", () => {
		const { element, events } = setup();
		fire(element, "pointerdown", { ...mouse, button: 2, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, button: 2, clientX: 90, clientY: 90 });
		expect(events).toEqual([]);

		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointerdown", { ...mouse, pointerId: 2, clientX: 300, clientY: 300 });
		fire(element, "pointermove", { ...mouse, pointerId: 2, clientX: 400, clientY: 400 });
		expect(events).toEqual([]);
		fire(element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		expect(events.map((event) => event.phase)).toEqual(["start", "move"]);
	});

	test("does not start while the host says it cannot", () => {
		const { controlsEnabled, element, events, host } = setup();
		host.canStart = () => false;
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		expect(controlsEnabled).toEqual([]);
		expect(events).toEqual([]);
	});

	test("a node that vanishes mid-drag ends the drag without moving anything", () => {
		const { controller, controlsEnabled, element, events, nodes } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 40, clientY: 40 });
		nodes.delete("a");
		fire(element, "pointermove", { ...mouse, clientX: 60, clientY: 60 });
		expect(events.at(-1)?.phase).toBe("cancel");
		expect(controlsEnabled).toEqual([false, true]);
		expect(controller.active).toBe(false);
		expect(nodes.has("a")).toBe(false);
	});

	test("disabling mid-drag cancels and restores", () => {
		const { controller, element, events, nodes } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		controller.setEnabled(false);
		expect(nodes.get("a")).toEqual({ x: 10, y: 20 });
		expect(events.at(-1)?.phase).toBe("cancel");
	});

	test("cancel({ restore: false }) leaves the node where it is", () => {
		const { controller, element, events, nodes } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		controller.cancel({ restore: false });
		expect(nodes.get("a")).toEqual({ x: 90, y: 90 });
		expect(events.at(-1)).toEqual({ nodeId: "a", phase: "cancel", position: { x: 90, y: 90 } });
	});

	test("dispose removes the listeners", () => {
		const { controller, element, events } = setup();
		controller.dispose();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 90, clientY: 90 });
		expect(events).toEqual([]);
	});
});

describe("NodeDragController depth", () => {
	test("a 2D node without z keeps no z while dragging", () => {
		const { element, nodes } = setup();
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 40, clientY: 40 });
		expect(nodes.get("a")).toEqual({ x: 40, y: 40 });
	});

	test("in 3D the node follows the surface depth and keeps its grab offset in z", () => {
		const { element, nodes } = setup({ is3d: true, startZ: 8 });
		// The surface reports z = 5 at the node, so the grab offset in z is 3 and stays.
		fire(element, "pointerdown", { ...mouse, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...mouse, clientX: 40, clientY: 40 });
		expect(nodes.get("a")).toEqual({ x: 40, y: 40, z: 8 });
	});
});

describe("NodeDragController with touch", () => {
	test("moving before the hold elapses is left to the camera", () => {
		const { controller, controlsEnabled, element, events } = setup();
		fire(element, "pointerdown", { ...touch, clientX: 10, clientY: 20 });
		fire(element, "pointermove", { ...touch, clientX: 10 + NODE_DRAG_TOLERANCE_PX + 1, clientY: 20 });
		vi.advanceTimersByTime(NODE_DRAG_TOUCH_HOLD_MS + 50);
		fire(element, "pointermove", { ...touch, clientX: 90, clientY: 90 });
		expect(events).toEqual([]);
		expect(controlsEnabled).toEqual([]);
		expect(controller.active).toBe(false);
	});

	test("a long press starts the drag, then the node follows", () => {
		const { controller, controlsEnabled, element, events, nodes } = setup();
		fire(element, "pointerdown", { ...touch, clientX: 10, clientY: 20 });
		expect(controlsEnabled).toEqual([]);
		vi.advanceTimersByTime(NODE_DRAG_TOUCH_HOLD_MS);
		expect(controller.active).toBe(true);
		expect(controlsEnabled).toEqual([false]);
		expect(events).toEqual([{ nodeId: "a", phase: "start", position: { x: 10, y: 20 } }]);
		fire(element, "pointermove", { ...touch, clientX: 70, clientY: 70 });
		expect(nodes.get("a")).toEqual({ x: 70, y: 70 });
		fire(element, "pointerup", { ...touch });
		expect(events.at(-1)?.phase).toBe("end");
		expect(controlsEnabled).toEqual([false, true]);
	});

	test("lifting the finger before the hold elapses is a tap", () => {
		const { controller, controlsEnabled, element, events } = setup();
		fire(element, "pointerdown", { ...touch, clientX: 10, clientY: 20 });
		fire(element, "pointerup", { ...touch });
		vi.advanceTimersByTime(NODE_DRAG_TOUCH_HOLD_MS * 2);
		expect(events).toEqual([]);
		expect(controlsEnabled).toEqual([]);
		expect(controller.active).toBe(false);
	});
});
