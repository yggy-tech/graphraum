import { describe, expect, test } from "vitest";

import {
	FAR_LOOK_DEFAULTS,
	FAR_LOOK_FAR_PIXELS,
	FAR_LOOK_NEAR_PIXELS,
	FAR_LOOK_STRENGTH,
	farLookAmount,
	referenceFarLookAmount,
	resolveFarLookOptions,
} from "./far-look";

describe("far look amount", () => {
	test("is off up close, full far out and eases in between", () => {
		expect(farLookAmount(FAR_LOOK_NEAR_PIXELS, FAR_LOOK_NEAR_PIXELS, FAR_LOOK_FAR_PIXELS)).toBe(0);
		expect(farLookAmount(200, FAR_LOOK_NEAR_PIXELS, FAR_LOOK_FAR_PIXELS)).toBe(0);
		expect(farLookAmount(FAR_LOOK_FAR_PIXELS, FAR_LOOK_NEAR_PIXELS, FAR_LOOK_FAR_PIXELS)).toBe(1);
		expect(farLookAmount(0.2, FAR_LOOK_NEAR_PIXELS, FAR_LOOK_FAR_PIXELS)).toBe(1);
		const middle = farLookAmount((FAR_LOOK_NEAR_PIXELS + FAR_LOOK_FAR_PIXELS) / 2, 10, 3);
		expect(middle).toBeCloseTo(0.5);
	});

	test("grows monotonically as nodes shrink", () => {
		const samples = [12, 9, 7, 5, 4, 3, 2].map((pixels) => farLookAmount(pixels, 10, 3));
		expect(samples).toEqual([...samples].sort((a, b) => a - b));
	});

	test("the reference node follows the world units per pixel and nothing else", () => {
		expect(referenceFarLookAmount(0.01, FAR_LOOK_DEFAULTS)).toBe(0);
		expect(referenceFarLookAmount(100, FAR_LOOK_DEFAULTS)).toBe(1);
		expect(referenceFarLookAmount(0, FAR_LOOK_DEFAULTS)).toBe(0);
		expect(referenceFarLookAmount(100, { ...FAR_LOOK_DEFAULTS, enabled: false })).toBe(0);
	});
});

describe("far look options", () => {
	test("default to strength 0.2 and a 3 to 10 pixel range", () => {
		expect(FAR_LOOK_STRENGTH).toBe(0.2);
		expect(resolveFarLookOptions({})).toEqual({ enabled: true, farPixels: 3, nearPixels: 10, strength: 0.2 });
	});

	test("false turns it off and keeps the rest", () => {
		expect(resolveFarLookOptions(false)).toMatchObject({ enabled: false, strength: 0.2 });
		expect(resolveFarLookOptions({}, resolveFarLookOptions(false)).enabled).toBe(true);
	});

	test("merges onto the current options", () => {
		const base = resolveFarLookOptions({ strength: 0.5 });
		expect(resolveFarLookOptions({ nearPixels: 20 }, base)).toMatchObject({ nearPixels: 20, strength: 0.5 });
	});

	test.each([
		[{ strength: 2 }, /strength/],
		[{ strength: Number.NaN }, /strength/],
		[{ nearPixels: 0 }, /nearPixels/],
		[{ farPixels: -1 }, /farPixels/],
		[{ farPixels: 12 }, /below nearPixels/],
	])("rejects %j", (options, message) => {
		expect(() => resolveFarLookOptions(options)).toThrow(message);
	});
});
