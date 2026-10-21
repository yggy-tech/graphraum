import { describe, expect, test } from "vitest";

import { perspectiveClipRange, validateCameraState } from "./camera-state";
import type { GraphraumCameraState } from "./types";

const state3d: GraphraumCameraState = { mode: "3d", position: { x: 1, y: 2, z: 300 }, target: { x: 0, y: 0, z: 0 } };
const state2d: GraphraumCameraState = { center: { x: 5, y: -6 }, mode: "2d", visibleHeight: 480 };

describe("validateCameraState", () => {
	test("returns a copy that equals a valid state", () => {
		const copy = validateCameraState(state3d, "3d");
		expect(copy).toEqual(state3d);
		expect(copy).not.toBe(state3d);
		expect(validateCameraState(state2d, "2d")).toEqual(state2d);
	});

	test("drops fields it does not know, so parsed JSON cannot smuggle them in", () => {
		const noisy = { ...state2d, extra: 1 } as GraphraumCameraState;
		expect(validateCameraState(noisy, "2d")).toEqual(state2d);
	});

	test("names both modes when they differ", () => {
		expect(() => validateCameraState(state3d, "2d")).toThrow(
			'Cannot apply a 3d camera state to a graph in 2d mode; call setMode("3d") first.',
		);
		expect(() => validateCameraState(state2d, "3d")).toThrow(/2d camera state to a graph in 3d mode/);
	});

	test.each([null, undefined, 5, "3d"])("rejects %j", (value) => {
		expect(() => validateCameraState(value as unknown as GraphraumCameraState, "3d")).toThrow(/must be an object/);
	});

	test("rejects an unknown mode", () => {
		expect(() => validateCameraState({ mode: "4d" } as unknown as GraphraumCameraState, "3d")).toThrow(
			/mode "2d" or "3d"/,
		);
	});

	test.each([
		["position.x", { ...state3d, position: { x: Number.NaN, y: 0, z: 1 } }],
		["target.z", { ...state3d, target: { x: 0, y: 0, z: Number.POSITIVE_INFINITY } }],
		["position.y", { ...state3d, position: { x: 0, z: 1 } }],
		["target.x", { ...state3d, target: undefined }],
		["center.x", { ...state2d, center: { x: "1", y: 0 } }],
		["visibleHeight", { ...state2d, visibleHeight: undefined }],
	])("rejects a bad %s", (name, bad) => {
		const mode = (bad as GraphraumCameraState).mode;
		expect(() => validateCameraState(bad as unknown as GraphraumCameraState, mode)).toThrow(
			new RegExp(`${name.replace(".", "\\.")} must be a finite number`),
		);
	});

	test("rejects a 2D view that shows nothing and a 3D camera sitting on its target", () => {
		expect(() => validateCameraState({ ...state2d, visibleHeight: 0 } as GraphraumCameraState, "2d")).toThrow(
			/above 0/,
		);
		expect(() => validateCameraState({ ...state2d, visibleHeight: -3 } as GraphraumCameraState, "2d")).toThrow(
			/above 0/,
		);
		expect(() =>
			validateCameraState({ mode: "3d", position: { x: 1, y: 1, z: 1 }, target: { x: 1, y: 1, z: 1 } }, "3d"),
		).toThrow(/must differ/);
	});
});

describe("perspectiveClipRange", () => {
	test("keeps the whole graph inside the far plane with room to zoom out", () => {
		const { far } = perspectiveClipRange(400, 5000);
		expect(far).toBeGreaterThanOrEqual((400 + 5000) * 1.1);
		expect(perspectiveClipRange(400, 10).far).toBe(4000);
	});

	test("keeps the near plane small, positive and in front of the target", () => {
		for (const distance of [0.05, 1, 400, 90_000]) {
			const { near } = perspectiveClipRange(distance, 100);
			expect(near).toBeGreaterThan(0);
			expect(near).toBeLessThan(distance);
		}
		expect(perspectiveClipRange(400, 100).near).toBe(0.1);
		expect(perspectiveClipRange(9_000_000, 100).near).toBe(900);
	});
});
