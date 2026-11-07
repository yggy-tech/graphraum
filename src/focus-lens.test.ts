import { describe, expect, test } from "vitest";

import {
	FOCUS_LENS_DEFAULTS,
	focusLens,
	focusLensLabelAlpha,
	focusLensScale,
	resolveFocusLensOptions,
} from "./focus-lens";

const VIEWPORT_MIN = 800;
const REACH_PX = 0.5 * VIEWPORT_MIN;

describe("focusLens", () => {
	test("is the center scale at the center, with a fully opaque label", () => {
		expect(focusLens(0, VIEWPORT_MIN)).toEqual({ labelAlpha: 1, scale: 2 });
	});

	test("is the edge scale at and beyond the reach, with no label", () => {
		expect(focusLens(REACH_PX, VIEWPORT_MIN)).toEqual({ labelAlpha: 0, scale: 0.75 });
		expect(focusLens(REACH_PX * 3, VIEWPORT_MIN)).toEqual({ labelAlpha: 0, scale: 0.75 });
	});

	test("falls off monotonically from the center to the reach", () => {
		let previous = Number.POSITIVE_INFINITY;
		let previousAlpha = Number.POSITIVE_INFINITY;
		for (let distance = 0; distance <= REACH_PX; distance += 10) {
			const { labelAlpha, scale } = focusLens(distance, VIEWPORT_MIN);
			expect(scale).toBeLessThanOrEqual(previous);
			expect(labelAlpha).toBeLessThanOrEqual(previousAlpha);
			previous = scale;
			previousAlpha = labelAlpha;
		}
	});

	test("eases through the middle with a smoothstep", () => {
		expect(focusLens(REACH_PX / 2, VIEWPORT_MIN).scale).toBeCloseTo((2 + 0.75) / 2, 10);
	});

	test("keeps labels off until the size passes the threshold", () => {
		const threshold = 1 + 0.45;
		const ramp = 0.35;
		expect(focusLensLabelAlpha(threshold, FOCUS_LENS_DEFAULTS)).toBe(0);
		expect(focusLensLabelAlpha(threshold + ramp / 2, FOCUS_LENS_DEFAULTS)).toBeCloseTo(0.5, 10);
		expect(focusLensLabelAlpha(threshold + ramp, FOCUS_LENS_DEFAULTS)).toBeCloseTo(1, 10);
		expect(focusLensLabelAlpha(threshold + ramp * 2, FOCUS_LENS_DEFAULTS)).toBe(1);
	});

	test("takes custom options", () => {
		const options = { centerScale: 3, edgeScale: 0.5, reach: 0.25, labelThreshold: 0.5, labelRamp: 0.25 };
		expect(focusLens(0, 400, options)).toEqual({ labelAlpha: 1, scale: 3 });
		expect(focusLens(100, 400, options)).toEqual({ labelAlpha: 0, scale: 0.5 });
		expect(focusLens(1000, 400, options).scale).toBe(0.5);
		// Reach is a fraction of the viewport's shorter side.
		expect(focusLens(50, 400, options).scale).toBeCloseTo(0.5 + 2.5 * 0.5, 10);
	});

	test("leaves labels alone when the lens never enlarges", () => {
		const options = resolveFocusLensOptions({ centerScale: 1, edgeScale: 0.5 });
		expect(focusLensLabelAlpha(0.5, options)).toBe(1);
	});

	test("handles a zero-size viewport without NaN", () => {
		expect(focusLensScale(10, 0, FOCUS_LENS_DEFAULTS)).toBe(0.75);
		expect(focusLensScale(0, 0, FOCUS_LENS_DEFAULTS)).toBe(2);
	});
});

describe("resolveFocusLensOptions", () => {
	test("is off by default and merges onto a base", () => {
		expect(FOCUS_LENS_DEFAULTS.enabled).toBe(false);
		const next = resolveFocusLensOptions({ enabled: true, reach: undefined }, FOCUS_LENS_DEFAULTS);
		expect(next).toEqual({ ...FOCUS_LENS_DEFAULTS, enabled: true });
	});

	test.each([
		["centerScale", 0],
		["edgeScale", -1],
		["reach", Number.NaN],
		["labelRamp", 0],
		["labelThreshold", -0.1],
		["easing", 0],
		["easing", 1.5],
	])("rejects %s = %s", (name, value) => {
		expect(() => resolveFocusLensOptions({ [name]: value })).toThrow(name);
	});

	test("rejects a non-boolean enabled", () => {
		expect(() => resolveFocusLensOptions({ enabled: "yes" as unknown as boolean })).toThrow("enabled");
	});
});
