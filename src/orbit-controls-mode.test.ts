import { MOUSE, OrthographicCamera, TOUCH } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { describe, expect, test } from "vitest";

import { configureControlsForMode } from "./orbit-controls-mode";

type Listener = (event: Record<string, unknown>) => void;

/** A canvas stand-in that keeps the listeners OrbitControls registers, so a test can fire pointer events. */
function fakeCanvas() {
	const listeners = new Map<string, Listener>();
	const register = (type: string, listener: Listener) => listeners.set(type, listener);
	const canvas = {
		addEventListener: register,
		clientHeight: 600,
		clientWidth: 800,
		getBoundingClientRect: () => ({ height: 600, left: 0, top: 0, width: 800 }),
		getRootNode: () => ({ addEventListener: () => {}, removeEventListener: () => {} }),
		ownerDocument: { addEventListener: register, removeEventListener: () => {} },
		releasePointerCapture: () => {},
		removeEventListener: () => {},
		setPointerCapture: () => {},
		style: {},
	};
	const fire = (type: string, pointerId: number, pageX: number, pageY: number) =>
		listeners.get(type)?.({ button: 0, pageX, pageY, pointerId, pointerType: "touch", preventDefault: () => {} });
	return { canvas, fire };
}

function controlsFor(mode: "2d" | "3d") {
	const { canvas, fire } = fakeCanvas();
	const controls = new OrbitControls(new OrthographicCamera(), canvas as unknown as HTMLElement);
	configureControlsForMode(controls, mode);
	return { controls, fire };
}

describe("configureControlsForMode", () => {
	test("a 2D pinch that ends with one finger still moving pans instead of throwing", () => {
		const { fire } = controlsFor("2d");

		fire("pointerdown", 1, 100, 100);
		fire("pointerdown", 2, 200, 200);
		fire("pointermove", 2, 220, 220);
		fire("pointerup", 2, 220, 220);

		expect(() => fire("pointermove", 1, 120, 110)).not.toThrow();
	});

	test("one finger pans and the left mouse button pans in 2D", () => {
		const { controls } = controlsFor("2d");

		expect(controls.enableRotate).toBe(false);
		expect(controls.touches.ONE).toBe(TOUCH.PAN);
		expect(controls.mouseButtons.LEFT).toBe(MOUSE.PAN);
	});

	test("3D keeps rotation on one finger", () => {
		const { controls } = controlsFor("3d");

		expect(controls.enableRotate).toBe(true);
		expect(controls.touches.ONE).toBe(TOUCH.ROTATE);
	});

	test("zooms toward the pointer in 2D and 3D", () => {
		for (const mode of ["2d", "3d"] as const) expect(controlsFor(mode).controls.zoomToCursor).toBe(true);
	});
});
