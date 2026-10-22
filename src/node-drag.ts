import type { GraphraumNodeDragEvent, GraphraumPosition } from "./types";

/** How far a pointer may travel after the press and still count as a click, in CSS pixels. */
export const NODE_DRAG_TOLERANCE_PX = 5;
/** How long a finger must rest on a node before it drags, so a swipe still pans the camera. */
export const NODE_DRAG_TOUCH_HOLD_MS = 350;

/** The world position under a pointer on the plane the node moves in, or `null` when there is none. */
export type NodeDragSurface = (clientX: number, clientY: number) => GraphraumPosition | null;

interface PointerSurfaceElement extends EventTarget {
	releasePointerCapture(pointerId: number): void;
	setPointerCapture(pointerId: number): void;
}

/** What the controller needs from the engine; everything else stays inside this module. */
export interface NodeDragHost {
	/** False while the viewport shows clusters instead of nodes. */
	canStart(): boolean;
	/** A surface through `anchor` facing the camera, or `null` when the canvas has no size. */
	createSurface(anchor: GraphraumPosition): NodeDragSurface | null;
	/** Receives Escape while a gesture is running. */
	document: EventTarget;
	element: PointerSurfaceElement;
	emit(event: GraphraumNodeDragEvent): void;
	moveNode(nodeId: string, position: GraphraumPosition): void;
	nodePosition(nodeId: string): GraphraumPosition | null;
	pickNode(clientX: number, clientY: number): string | null;
	setControlsEnabled(enabled: boolean): void;
}

interface Gesture {
	/** Whether the camera controls were switched off for this gesture. */
	controlsHeld: boolean;
	holdTimer: ReturnType<typeof setTimeout> | null;
	last: GraphraumPosition;
	nodeId: string;
	/** Node position minus the pointer's surface position at the press, so the node does not jump. */
	offset: { x: number; y: number; z: number };
	origin: GraphraumPosition;
	phase: "dragging" | "pressed";
	pointerId: number;
	startX: number;
	startY: number;
	surface: NodeDragSurface;
	touch: boolean;
}

/**
 * Drags one node with the pointer. A press on a node arms a gesture; once the pointer leaves the
 * click tolerance (a finger must rest on the node first) the node follows it until release.
 * Camera controls are switched off for the gesture and restored when it ends, so a press that stays
 * a click behaves as before. Escape, a cancelled pointer or lost pointer capture put the node back.
 */
export class NodeDragController {
	private enabled = false;
	private gesture: Gesture | null = null;
	private readonly unlisten: Array<() => void>;
	private unlistenKeys: (() => void) | null = null;

	constructor(
		private readonly host: NodeDragHost,
		private readonly holdMs = NODE_DRAG_TOUCH_HOLD_MS,
	) {
		// Capture, and register before the camera controls do: a press on a node must reach us first.
		this.unlisten = [
			listen(host.element, "pointerdown", this.handleDown, { capture: true }),
			listen(host.element, "pointermove", this.handleMove),
			listen(host.element, "pointerup", this.handleUp),
			listen(host.element, "pointercancel", this.handleCancel),
			listen(host.element, "lostpointercapture", this.handleCancel),
		];
	}

	/** True from the first drag step until the node is dropped or the drag is cancelled. */
	get active(): boolean {
		return this.gesture?.phase === "dragging";
	}

	setEnabled(enabled: boolean) {
		if (!enabled) this.cancel({ restore: true });
		this.enabled = enabled;
	}

	/** Ends a running gesture as cancelled. `restore` puts the node back where it was grabbed. */
	cancel({ restore }: { restore: boolean }) {
		const gesture = this.gesture;
		if (!gesture) return;
		if (gesture.phase === "dragging") {
			// A node the data replacement removed cannot be put back.
			const restored = restore && this.host.nodePosition(gesture.nodeId) !== null;
			if (restored) this.host.moveNode(gesture.nodeId, gesture.origin);
			this.finish(gesture);
			this.host.emit({ nodeId: gesture.nodeId, phase: "cancel", position: restored ? gesture.origin : gesture.last });
			return;
		}
		this.finish(gesture);
	}

	dispose() {
		this.cancel({ restore: false });
		this.enabled = false;
		for (const stop of this.unlisten) stop();
	}

	private readonly handleDown = (event: PointerEvent) => {
		if (!this.enabled || this.gesture || event.button !== 0 || !this.host.canStart()) return;
		const nodeId = this.host.pickNode(event.clientX, event.clientY);
		if (nodeId === null) return;
		const origin = this.host.nodePosition(nodeId);
		if (!origin) return;
		const surface = this.host.createSurface(origin);
		const grabbed = surface?.(event.clientX, event.clientY);
		if (!surface || !grabbed) return;
		const touch = event.pointerType === "touch";
		const gesture: Gesture = {
			controlsHeld: false,
			holdTimer: null,
			last: origin,
			nodeId,
			offset: { x: origin.x - grabbed.x, y: origin.y - grabbed.y, z: (origin.z ?? 0) - (grabbed.z ?? 0) },
			origin,
			phase: "pressed",
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			surface,
			touch,
		};
		this.gesture = gesture;
		this.unlistenKeys = listen(this.host.document, "keydown", this.handleKey);
		if (touch) {
			gesture.holdTimer = setTimeout(() => this.beginDrag(gesture), this.holdMs);
			return;
		}
		// A mouse or pen press on a node belongs to the node, not to the camera.
		this.holdControls(gesture);
		capture(this.host.element, event.pointerId);
	};

	private readonly handleMove = (event: PointerEvent) => {
		const gesture = this.gesture;
		if (!gesture || event.pointerId !== gesture.pointerId) return;
		if (gesture.phase === "pressed") {
			const travelled = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
			if (travelled <= NODE_DRAG_TOLERANCE_PX) return;
			// A finger that moves before the hold elapses is a camera pan.
			if (gesture.touch) {
				this.finish(gesture);
				return;
			}
			this.beginDrag(gesture);
		}
		this.follow(gesture, event.clientX, event.clientY);
	};

	private readonly handleUp = (event: PointerEvent) => {
		const gesture = this.gesture;
		if (!gesture || event.pointerId !== gesture.pointerId) return;
		this.finish(gesture);
		if (gesture.phase === "dragging") {
			this.host.emit({ nodeId: gesture.nodeId, phase: "end", position: gesture.last });
		}
	};

	private readonly handleCancel = (event: PointerEvent) => {
		if (this.gesture && event.pointerId === this.gesture.pointerId) this.cancel({ restore: true });
	};

	private readonly handleKey = (event: KeyboardEvent) => {
		if (event.key === "Escape") this.cancel({ restore: true });
	};

	private beginDrag(gesture: Gesture) {
		if (this.gesture !== gesture || gesture.phase === "dragging") return;
		gesture.phase = "dragging";
		clearHold(gesture);
		this.holdControls(gesture);
		if (gesture.touch) capture(this.host.element, gesture.pointerId);
		this.host.emit({ nodeId: gesture.nodeId, phase: "start", position: gesture.origin });
	}

	private follow(gesture: Gesture, clientX: number, clientY: number) {
		if (!this.host.nodePosition(gesture.nodeId)) {
			// The data was replaced under the drag; there is nothing left to move or restore.
			this.cancel({ restore: false });
			return;
		}
		const point = gesture.surface(clientX, clientY);
		if (!point) return;
		const z = point.z === undefined ? gesture.origin.z : point.z + gesture.offset.z;
		const position: GraphraumPosition = {
			x: point.x + gesture.offset.x,
			y: point.y + gesture.offset.y,
			...(z === undefined ? {} : { z }),
		};
		gesture.last = position;
		this.host.moveNode(gesture.nodeId, position);
		this.host.emit({ nodeId: gesture.nodeId, phase: "move", position });
	}

	private holdControls(gesture: Gesture) {
		if (gesture.controlsHeld) return;
		gesture.controlsHeld = true;
		this.host.setControlsEnabled(false);
	}

	/** Drops the gesture and everything it held: timer, pointer capture, key listener, camera controls. */
	private finish(gesture: Gesture) {
		if (this.gesture !== gesture) return;
		this.gesture = null;
		clearHold(gesture);
		this.unlistenKeys?.();
		this.unlistenKeys = null;
		release(this.host.element, gesture.pointerId);
		if (gesture.controlsHeld) this.host.setControlsEnabled(true);
	}
}

/** Typed `addEventListener` for the pointer and key events this module handles; returns the unsubscribe. */
function listen<E extends Event>(
	target: EventTarget,
	type: string,
	handler: (event: E) => void,
	options?: AddEventListenerOptions,
): () => void {
	const listener = handler as unknown as EventListener;
	target.addEventListener(type, listener, options);
	return () => target.removeEventListener(type, listener, options);
}

function clearHold(gesture: Gesture) {
	if (gesture.holdTimer === null) return;
	clearTimeout(gesture.holdTimer);
	gesture.holdTimer = null;
}

// Capturing a pointer that is already gone throws; the gesture simply loses events outside the canvas.
function capture(element: PointerSurfaceElement, pointerId: number) {
	try {
		element.setPointerCapture(pointerId);
	} catch {}
}

function release(element: PointerSurfaceElement, pointerId: number) {
	try {
		element.releasePointerCapture(pointerId);
	} catch {}
}
