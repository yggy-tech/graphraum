import { Matrix4, PerspectiveCamera } from "three";
import { describe, expect, test } from "vitest";

import {
	circleOfConfusion,
	DEPTH_OF_FIELD_DEFAULTS,
	DEPTH_OF_FIELD_FALLOFF,
	DepthOfFieldFocus,
	depthOfFieldMaxBlurPixels,
	meanPoint,
	resolveDepthOfFieldOptions,
	viewDistance,
} from "./depth-of-field";

describe("resolveDepthOfFieldOptions", () => {
	test("defaults leave depth of field off", () => {
		expect(DEPTH_OF_FIELD_DEFAULTS).toEqual({ enabled: false, focus: "selection", strength: 0.5, transitionMs: 400 });
		expect(resolveDepthOfFieldOptions({})).toEqual(DEPTH_OF_FIELD_DEFAULTS);
	});

	test("merges onto the current options", () => {
		const enabled = resolveDepthOfFieldOptions({ enabled: true, strength: 0.8 });
		expect(resolveDepthOfFieldOptions({ focus: 250 }, enabled)).toEqual({
			enabled: true,
			focus: 250,
			strength: 0.8,
			transitionMs: 400,
		});
		expect(resolveDepthOfFieldOptions({ enabled: false }, enabled).strength).toBe(0.8);
	});

	test.each([
		[{ strength: -0.1 }, /strength must be a number from 0 to 1/],
		[{ strength: 1.5 }, /strength must be a number from 0 to 1/],
		[{ strength: Number.NaN }, /strength/],
		[{ focus: 0 }, /focus must be "selection" or a camera distance above 0/],
		[{ focus: "nearest" as never }, /focus/],
		[{ transitionMs: -1 }, /transitionMs must be a non-negative finite number/],
		[{ transitionMs: Number.POSITIVE_INFINITY }, /transitionMs/],
		[{ enabled: "yes" as never }, /enabled must be a boolean/],
	])("rejects %o", (options, message) => {
		expect(() => resolveDepthOfFieldOptions(options)).toThrow(message);
	});

	test("rejects a non-object", () => {
		expect(() => resolveDepthOfFieldOptions(true as never)).toThrow(/must be an object/);
	});
});

describe("blur radius", () => {
	test("strength scales a 12 CSS pixel maximum by the pixel ratio", () => {
		expect(depthOfFieldMaxBlurPixels(1, 1)).toBe(12);
		expect(depthOfFieldMaxBlurPixels(0.5, 2)).toBe(12);
		expect(depthOfFieldMaxBlurPixels(0, 2)).toBe(0);
	});

	test("is zero on the focal plane and grows with relative distance from it", () => {
		expect(circleOfConfusion(100, 100, 12)).toBe(0);
		expect(circleOfConfusion(100 + 100 * DEPTH_OF_FIELD_FALLOFF * 0.5, 100, 12)).toBeCloseTo(6);
		expect(circleOfConfusion(100 - 100 * DEPTH_OF_FIELD_FALLOFF * 0.5, 100, 12)).toBeCloseTo(6);
		expect(circleOfConfusion(10_000, 100, 12)).toBe(12);
	});

	test("does not depend on the graph's world scale", () => {
		expect(circleOfConfusion(130, 100, 12)).toBeCloseTo(circleOfConfusion(13_000, 10_000, 12));
	});

	test("is zero without a focal plane", () => {
		expect(circleOfConfusion(50, 0, 12)).toBe(0);
	});
});

describe("viewDistance", () => {
	test("matches the camera-space depth of a point", () => {
		const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
		camera.position.set(10, 20, 300);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld();
		const point = { x: 5, y: -8, z: 40 };
		const expected = -new Matrix4()
			.copy(camera.matrixWorldInverse)
			.multiply(new Matrix4().makeTranslation(point.x, point.y, point.z)).elements[14];
		expect(viewDistance(point, camera.matrixWorldInverse.elements)).toBeCloseTo(expected);
		expect(viewDistance({ x: 0, y: 0, z: 0 }, camera.matrixWorldInverse.elements)).toBeCloseTo(Math.hypot(10, 20, 300));
	});
});

test("meanPoint averages points and is null for none", () => {
	expect(meanPoint([])).toBeNull();
	expect(
		meanPoint([
			{ x: 0, y: 0, z: 0 },
			{ x: 2, y: 4, z: -6 },
		]),
	).toEqual({ x: 1, y: 2, z: -3 });
});

describe("DepthOfFieldFocus", () => {
	const a = { x: 0, y: 0, z: 0 };
	const b = { x: 100, y: 0, z: 0 };

	test("is settled with no blur before anything is selected", () => {
		const focus = new DepthOfFieldFocus();
		expect(focus.evaluate(0, null, 400, false)).toEqual({ amount: 0, point: null, settled: true });
	});

	test("fades in at the first selection, then moves the focus point to a new selection", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget();
		expect(focus.evaluate(1000, a, 400, false)).toEqual({ amount: 0, point: a, settled: false });
		expect(focus.evaluate(1200, a, 400, false)).toMatchObject({ amount: 0.5, point: a, settled: false });
		expect(focus.evaluate(1400, a, 400, false)).toEqual({ amount: 1, point: a, settled: true });

		focus.retarget();
		expect(focus.evaluate(2000, b, 400, false).point).toEqual(a);
		const halfway = focus.evaluate(2200, b, 400, false);
		expect(halfway.amount).toBe(1);
		expect(halfway.point?.x).toBeCloseTo(50);
		expect(focus.evaluate(2400, b, 400, false)).toEqual({ amount: 1, point: b, settled: true });
	});

	test("fades out around the last focus point when the selection clears", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget();
		focus.evaluate(0, a, 0, true);
		focus.retarget();
		focus.evaluate(0, null, 400, false);
		expect(focus.evaluate(200, null, 400, false)).toMatchObject({ amount: 0.5, point: a, settled: false });
		expect(focus.evaluate(400, null, 400, false)).toEqual({ amount: 0, point: a, settled: true });
	});

	test("a retarget mid-transition starts from the focus shown last", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget();
		focus.evaluate(0, a, 0, true);
		focus.retarget();
		focus.evaluate(0, b, 400, false);
		const shown = focus.evaluate(200, b, 400, false).point;
		focus.retarget();
		expect(focus.evaluate(300, a, 400, false).point).toEqual(shown);
	});

	test("reduced motion jumps", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget();
		expect(focus.evaluate(0, b, 400, true)).toEqual({ amount: 1, point: b, settled: true });
	});

	test("follows a moving target once settled", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget();
		focus.evaluate(0, a, 0, true);
		expect(focus.evaluate(10, b, 400, false)).toEqual({ amount: 1, point: b, settled: true });
	});
});
