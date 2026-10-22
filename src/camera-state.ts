import type { GraphraumCameraState, GraphraumMode } from "./types";

/**
 * Checks a camera state before it touches the camera: an object of the graph's mode with finite
 * numbers, a positive visible height in 2D, and a position apart from the target in 3D. The state
 * is usually parsed JSON, so nothing about its shape is taken on trust.
 */
export function validateCameraState(state: GraphraumCameraState, mode: GraphraumMode): GraphraumCameraState {
	if (typeof state !== "object" || state === null) {
		throw new Error("A camera state must be an object returned by getCameraState().");
	}
	const stateMode: unknown = state.mode;
	if (stateMode !== "2d" && stateMode !== "3d") {
		throw new Error(`A camera state needs mode "2d" or "3d"; received ${JSON.stringify(stateMode)}.`);
	}
	if (state.mode !== mode) {
		throw new Error(
			`Cannot apply a ${state.mode} camera state to a graph in ${mode} mode; call setMode("${state.mode}") first.`,
		);
	}
	if (state.mode === "2d") {
		const x = finite(state.center?.x, "center.x");
		const y = finite(state.center?.y, "center.y");
		const visibleHeight = finite(state.visibleHeight, "visibleHeight");
		if (visibleHeight <= 0) throw new Error(`Camera state visibleHeight must be above 0; received ${visibleHeight}.`);
		return { center: { x, y }, mode: "2d", visibleHeight };
	}
	const position = point3d(state.position, "position");
	const target = point3d(state.target, "target");
	if (position.x === target.x && position.y === target.y && position.z === target.z) {
		throw new Error("Camera state position and target must differ.");
	}
	return { mode: "3d", position, target };
}

function point3d(value: { x: number; y: number; z: number } | undefined, name: string) {
	return { x: finite(value?.x, `${name}.x`), y: finite(value?.y, `${name}.y`), z: finite(value?.z, `${name}.z`) };
}

function finite(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Camera state ${name} must be a finite number; received ${String(value)}.`);
	}
	return value;
}

/**
 * Clip planes for a perspective camera `distance` from its target with the graph reaching
 * `graphRadius` around it: the far plane holds the whole graph with the slack a fit leaves for
 * zooming out, and the near plane stays close enough not to cut nodes in front of the camera.
 */
export function perspectiveClipRange(distance: number, graphRadius: number): { far: number; near: number } {
	return {
		far: Math.max(distance * 10, (distance + graphRadius) * 1.1),
		near: Math.min(Math.max(distance / 10_000, 0.1), distance / 2),
	};
}
