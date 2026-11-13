import { MOUSE, TOUCH } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { GraphraumMode } from "./types";

/**
 * Sets the controls for a 2D or 3D view. 2D turns rotation off, so one finger and the left
 * mouse button pan instead. One finger must not stay on ROTATE: when a pinch ends with one finger
 * still down, OrbitControls (r185) re-reads `touches.ONE`, returns early for a disabled rotate and
 * keeps the two-finger state, and the next move reads the lifted finger's position and throws.
 */
export function configureControlsForMode(controls: OrbitControls, mode: GraphraumMode): void {
	controls.enableRotate = mode === "3d";
	// Wheel and pinch zoom keep the point under the pointer in place instead of zooming into the centre.
	controls.zoomToCursor = true;
	if (mode === "2d") {
		controls.minZoom = 0.01;
		controls.mouseButtons.LEFT = MOUSE.PAN;
		controls.touches.ONE = TOUCH.PAN;
	}
}
