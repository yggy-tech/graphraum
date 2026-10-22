import { Matrix4, PerspectiveCamera } from "three";
import { describe, expect, test } from "vitest";

import {
	circleOfConfusion,
	DEPTH_OF_FIELD_DEFAULTS,
	DepthOfFieldFocus,
	distanceFade,
	meanPoint,
	resolveDepthOfFieldOptions,
	resolveEasing,
	Tween,
	viewDistance,
} from "./depth-of-field";

describe("resolveDepthOfFieldOptions", () => {
	test("defaults leave depth of field off", () => {
		expect(DEPTH_OF_FIELD_DEFAULTS).toEqual({
			enabled: false,
			farDistance: Number.POSITIVE_INFINITY,
			focus: "selection",
			maxBlur: 12,
			minBlur: 0,
			nearDistance: 0,
			strength: 0.5,
			transition: { durationMs: 400, easing: "easeInOut" },
		});
		expect(resolveDepthOfFieldOptions({})).toEqual(DEPTH_OF_FIELD_DEFAULTS);
	});

	test("merges onto the current options, including a partial transition", () => {
		const enabled = resolveDepthOfFieldOptions({ enabled: true, strength: 0.8, transition: { easing: "linear" } });
		const next = resolveDepthOfFieldOptions({ focus: 250, transition: { durationMs: 900 } }, enabled);
		expect(next).toMatchObject({ enabled: true, focus: 250, strength: 0.8 });
		expect(next.transition).toEqual({ durationMs: 900, easing: "linear" });
		expect(resolveDepthOfFieldOptions({ enabled: false }, enabled).strength).toBe(0.8);
	});

	test("accepts a custom easing function", () => {
		const easing = (t: number) => t * t;
		expect(resolveDepthOfFieldOptions({ transition: { easing } }).transition.easing).toBe(easing);
	});

	test.each([
		[{ strength: -0.1 }, /strength must be a number from 0 to 1/],
		[{ strength: 1.5 }, /strength must be a number from 0 to 1/],
		[{ strength: Number.NaN }, /strength/],
		[{ focus: 0 }, /focus must be "selection" or a camera distance above 0/],
		[{ focus: "nearest" as never }, /focus/],
		[{ maxBlur: -1 }, /minBlur and maxBlur/],
		[{ maxBlur: 2, minBlur: 3 }, /minBlur <= maxBlur/],
		[{ nearDistance: 500, farDistance: 400 }, /nearDistance must be a non-negative world distance below farDistance/],
		[{ nearDistance: -1 }, /nearDistance/],
		[{ transition: { durationMs: -1 } }, /transition durationMs must be a non-negative finite number/],
		[
			{ transition: { easing: "bounce" as never } },
			/easing must be "linear", "easeIn", "easeOut", "easeInOut" or a function/,
		],
		[{ transition: 400 as never }, /transition must be an object/],
		[{ enabled: "yes" as never }, /enabled must be a boolean/],
	])("rejects %o", (options, message) => {
		expect(() => resolveDepthOfFieldOptions(options)).toThrow(message);
	});

	test("rejects a non-object", () => {
		expect(() => resolveDepthOfFieldOptions(true as never)).toThrow(/must be an object/);
	});
});

describe("easing", () => {
	test.each(["linear", "easeIn", "easeOut", "easeInOut"] as const)("%s runs from 0 to 1", (name) => {
		const easing = resolveEasing(name);
		expect(easing(0)).toBe(0);
		expect(easing(1)).toBe(1);
	});

	test("easeIn starts slow, easeOut ends slow, easeInOut is symmetric", () => {
		expect(resolveEasing("linear")(0.25)).toBe(0.25);
		expect(resolveEasing("easeIn")(0.25)).toBeCloseTo(0.015625);
		expect(resolveEasing("easeOut")(0.75)).toBeCloseTo(1 - 0.015625);
		expect(resolveEasing("easeInOut")(0.5)).toBe(0.5);
		expect(resolveEasing("easeInOut")(0.25) + resolveEasing("easeInOut")(0.75)).toBeCloseTo(1);
	});

	test("passes a custom function through", () => {
		const easing = (t: number) => Math.sqrt(t);
		expect(resolveEasing(easing)).toBe(easing);
	});
});

describe("Tween", () => {
	const linear = resolveEasing("linear");

	test("animates to the target with the easing and resolves true on arrival", async () => {
		const tween = new Tween(0);
		const done = tween.retarget(1, 400, resolveEasing("easeIn"));
		expect(tween.settled).toBe(false);
		expect(tween.sample(1000)).toBe(0);
		expect(tween.sample(1200)).toBeCloseTo(0.125);
		expect(tween.sample(1400)).toBe(1);
		expect(tween.settled).toBe(true);
		await expect(done).resolves.toBe(true);
	});

	test("an interruption continues from the value shown last instead of restarting", async () => {
		const tween = new Tween(0);
		const first = tween.retarget(1, 400, linear);
		tween.sample(0);
		expect(tween.sample(200)).toBeCloseTo(0.5);
		const second = tween.retarget(0, 400, linear);
		await expect(first).resolves.toBe(false);
		expect(tween.sample(250)).toBeCloseTo(0.5);
		expect(tween.sample(450)).toBeCloseTo(0.25);
		expect(tween.sample(650)).toBe(0);
		await expect(second).resolves.toBe(true);
	});

	test("a zero duration or an unchanged target jumps and resolves at once", async () => {
		const tween = new Tween(0.2);
		await expect(tween.retarget(0.2, 400, linear)).resolves.toBe(true);
		await expect(tween.retarget(0.7, 0, linear)).resolves.toBe(true);
		expect(tween.sample(0)).toBe(0.7);
		expect(tween.settled).toBe(true);
	});

	test("jump arrives now and cancel resolves false", async () => {
		const jumped = new Tween(0);
		const arrival = jumped.retarget(1, 400, linear);
		jumped.jump();
		expect(jumped.sample(0)).toBe(1);
		await expect(arrival).resolves.toBe(true);
		const cancelled = new Tween(0);
		const interrupted = cancelled.retarget(1, 400, linear);
		cancelled.cancel();
		await expect(interrupted).resolves.toBe(false);
	});
});

describe("blur radius", () => {
	const lens = { aperturePixels: 24, maxBlurPixels: 1000, minBlurPixels: 0 };

	test("is zero on the focal plane", () => {
		expect(circleOfConfusion(100, 100, lens)).toBe(0);
	});

	test("follows the thin lens: aperture * |d - f| / d, stronger in front of the focus than behind", () => {
		expect(circleOfConfusion(200, 100, lens)).toBeCloseTo(12);
		expect(circleOfConfusion(50, 100, lens)).toBeCloseTo(24);
		expect(circleOfConfusion(150, 100, lens)).toBeLessThan(circleOfConfusion(50, 100, lens));
	});

	test("gets shallower as the camera moves closer to the focus", () => {
		// The same 50-unit offset behind the focus, with the camera far and near.
		expect(circleOfConfusion(450, 400, lens)).toBeLessThan(circleOfConfusion(150, 100, lens));
	});

	test("does not depend on the graph's world scale", () => {
		expect(circleOfConfusion(130, 100, lens)).toBeCloseTo(circleOfConfusion(13_000, 10_000, lens));
	});

	test("clamps to the maximum and renders radii below the minimum sharp", () => {
		expect(circleOfConfusion(10_000, 100, { ...lens, maxBlurPixels: 12 })).toBe(12);
		expect(circleOfConfusion(110, 100, { ...lens, minBlurPixels: 3 })).toBe(0);
		expect(circleOfConfusion(150, 100, { ...lens, minBlurPixels: 3 })).toBeCloseTo(8);
	});

	test("is zero without a focal plane", () => {
		expect(circleOfConfusion(50, 0, lens)).toBe(0);
	});
});

describe("distanceFade", () => {
	test("is full up to nearDistance and gone from farDistance, smooth in between", () => {
		expect(distanceFade(50, 100, 300)).toBe(1);
		expect(distanceFade(100, 100, 300)).toBe(1);
		expect(distanceFade(200, 100, 300)).toBeCloseTo(0.5);
		expect(distanceFade(150, 100, 300)).toBeGreaterThan(0.5);
		expect(distanceFade(300, 100, 300)).toBe(0);
		expect(distanceFade(1e9, 100, 300)).toBe(0);
	});

	test("never fades with the default infinite farDistance", () => {
		expect(distanceFade(1e12, 0, Number.POSITIVE_INFINITY)).toBe(1);
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
	const easeInOut = resolveEasing("easeInOut");
	const a = { x: 0, y: 0, z: 0 };
	const b = { x: 100, y: 0, z: 0 };

	test("is settled with no blur before anything is selected", () => {
		const focus = new DepthOfFieldFocus();
		expect(focus.evaluate(0, null, false)).toEqual({ amount: 0, point: null, settled: true });
	});

	test("fades in at the first selection, then moves the focus point to a new selection", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget(400, easeInOut);
		expect(focus.evaluate(1000, a, false)).toEqual({ amount: 0, point: a, settled: false });
		expect(focus.evaluate(1200, a, false)).toMatchObject({ amount: 0.5, point: a, settled: false });
		expect(focus.evaluate(1400, a, false)).toEqual({ amount: 1, point: a, settled: true });

		focus.retarget(400, easeInOut);
		expect(focus.evaluate(2000, b, false).point).toEqual(a);
		const halfway = focus.evaluate(2200, b, false);
		expect(halfway.amount).toBe(1);
		expect(halfway.point?.x).toBeCloseTo(50);
		expect(focus.evaluate(2400, b, false)).toEqual({ amount: 1, point: b, settled: true });
	});

	test("fades out around the last focus point when the selection clears", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget(400, easeInOut);
		focus.evaluate(0, a, true);
		focus.retarget(400, easeInOut);
		focus.evaluate(0, null, false);
		expect(focus.evaluate(200, null, false)).toMatchObject({ amount: 0.5, point: a, settled: false });
		expect(focus.evaluate(400, null, false)).toEqual({ amount: 0, point: a, settled: true });
	});

	test("a retarget mid-transition starts from the focus shown last", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget(400, easeInOut);
		focus.evaluate(0, a, true);
		focus.retarget(400, easeInOut);
		focus.evaluate(0, b, false);
		const shown = focus.evaluate(200, b, false).point;
		focus.retarget(400, easeInOut);
		expect(focus.evaluate(300, a, false).point).toEqual(shown);
	});

	test("uses the configured easing", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget(400, resolveEasing("easeIn"));
		focus.evaluate(0, a, false);
		expect(focus.evaluate(200, a, false).amount).toBeCloseTo(0.125);
	});

	test("reduced motion jumps", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget(400, easeInOut);
		expect(focus.evaluate(0, b, true)).toEqual({ amount: 1, point: b, settled: true });
	});

	test("follows a moving target once settled", () => {
		const focus = new DepthOfFieldFocus();
		focus.retarget(400, easeInOut);
		focus.evaluate(0, a, true);
		expect(focus.evaluate(10, b, false)).toEqual({ amount: 1, point: b, settled: true });
	});
});
