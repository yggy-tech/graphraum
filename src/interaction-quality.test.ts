import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	INTERACTION_QUALITY_DEFAULTS,
	InteractionQualityGovernor,
	nextInteractionTier,
	resolveInteractionQualityOptions,
	scaledBudget,
	scaledPixelRatio,
} from "./interaction-quality";

describe("resolveInteractionQualityOptions", () => {
	test("is off by default and merges onto a base", () => {
		expect(INTERACTION_QUALITY_DEFAULTS.enabled).toBe(false);
		const resolved = resolveInteractionQualityOptions({ enabled: true, idleMs: undefined, targetFrameMs: 16 });
		expect(resolved).toEqual({ enabled: true, idleMs: 200, targetFrameMs: 16 });
		expect(resolveInteractionQualityOptions({ idleMs: 300 }, resolved)).toEqual({
			enabled: true,
			idleMs: 300,
			targetFrameMs: 16,
		});
	});

	test("rejects invalid values", () => {
		expect(() => resolveInteractionQualityOptions({ enabled: "yes" as unknown as boolean })).toThrow(/enabled/);
		expect(() => resolveInteractionQualityOptions({ idleMs: 0 })).toThrow(/idleMs/);
		expect(() => resolveInteractionQualityOptions({ targetFrameMs: Number.NaN })).toThrow(/targetFrameMs/);
	});
});

describe("tier scaling", () => {
	test("scales budgets and pixel ratio per tier and never reaches 0", () => {
		expect(scaledBudget(100_000, 0)).toBe(100_000);
		expect(scaledBudget(100_000, 1)).toBe(50_000);
		expect(scaledBudget(100_000, 2)).toBe(25_000);
		expect(scaledBudget(1, 2)).toBe(1);
		expect(scaledPixelRatio(2, 0)).toBe(2);
		expect(scaledPixelRatio(2, 2)).toBe(1);
	});
});

describe("nextInteractionTier", () => {
	const target = 25;

	test("needs three consecutive slow frames to drop one tier", () => {
		let state = { slowFrames: 0, tier: 0 };
		state = nextInteractionTier(state, 60, target);
		state = nextInteractionTier(state, 60, target);
		expect(state.tier).toBe(0);
		state = nextInteractionTier(state, 60, target);
		expect(state).toEqual({ slowFrames: 0, tier: 1 });
	});

	test("a fast frame resets the count, and jitter within 20 percent is not slow", () => {
		expect(nextInteractionTier({ slowFrames: 2, tier: 0 }, 30, target)).toEqual({ slowFrames: 0, tier: 0 });
		expect(nextInteractionTier({ slowFrames: 2, tier: 0 }, 10, target).slowFrames).toBe(0);
	});

	test("stops at the lowest tier and never rises on its own", () => {
		let state = { slowFrames: 0, tier: 2 };
		for (let index = 0; index < 10; index += 1) state = nextInteractionTier(state, 100, target);
		expect(state.tier).toBe(2);
		for (let index = 0; index < 100; index += 1) state = nextInteractionTier(state, 1, target);
		expect(state.tier).toBe(2);
	});
});

describe("InteractionQualityGovernor", () => {
	let clock = 0;
	let applied: number[] = [];
	let governor: InteractionQualityGovernor;
	const options = { enabled: true, idleMs: 200, targetFrameMs: 25 };

	/** One camera frame that arrives `gap` ms after the previous one; timers and clock move together. */
	function cameraFrame(gap: number) {
		advance(gap);
		governor.motion();
		governor.frame();
	}

	function advance(ms: number) {
		for (let elapsed = 0; elapsed < ms; elapsed += 1) {
			clock += 1;
			vi.advanceTimersByTime(1);
		}
	}

	beforeEach(() => {
		vi.useFakeTimers();
		clock = 1000;
		applied = [];
		governor = new InteractionQualityGovernor(
			options,
			() => applied.push(governor.tier),
			() => clock,
		);
	});

	afterEach(() => {
		governor.dispose();
		vi.useRealTimers();
	});

	test("steady fast frames never change the tier", () => {
		for (let index = 0; index < 60; index += 1) cameraFrame(16);
		expect(governor.tier).toBe(0);
		expect(applied).toEqual([]);
	});

	test("slow camera frames step down, one apply per step, and the paying frame is not sampled", () => {
		cameraFrame(0);
		for (let index = 0; index < 3; index += 1) cameraFrame(50);
		expect(governor.tier).toBe(1);
		// The frame after a switch only restarts the clock, so three more slow frames are needed.
		cameraFrame(50);
		for (let index = 0; index < 2; index += 1) cameraFrame(50);
		expect(governor.tier).toBe(1);
		cameraFrame(50);
		expect(governor.tier).toBe(2);
		expect(applied).toEqual([1, 2]);
	});

	test("frames without a camera change are not timed", () => {
		cameraFrame(0);
		for (let index = 0; index < 20; index += 1) {
			clock += 100;
			governor.frame();
		}
		expect(governor.tier).toBe(0);
	});

	test("a pause longer than idleMs clears the frame clock, so the next frame is not a slow one", () => {
		cameraFrame(0);
		cameraFrame(50);
		cameraFrame(50);
		advance(500);
		for (let index = 0; index < 2; index += 1) cameraFrame(50);
		expect(governor.tier).toBe(0);
	});

	test("a late timer with camera changes still queued waits one more period", () => {
		cameraFrame(0);
		for (let index = 0; index < 3; index += 1) cameraFrame(50);
		expect(governor.tier).toBe(1);
		governor.motion();
		// The thread was busy: the clock ran 1 s ahead of the timer.
		clock += 1000;
		advance(200);
		expect(governor.tier).toBe(1);
		advance(200);
		expect(governor.tier).toBe(0);
	});

	test("the last camera change restores after idleMs, not twice that", () => {
		cameraFrame(0);
		for (let index = 0; index < 3; index += 1) cameraFrame(50);
		advance(200);
		expect(governor.tier).toBe(0);
	});

	test("restores tier 0 once, after the camera rested for idleMs", () => {
		cameraFrame(0);
		for (let index = 0; index < 3; index += 1) cameraFrame(50);
		expect(governor.tier).toBe(1);
		advance(150);
		expect(governor.tier).toBe(1);
		advance(60);
		expect(governor.tier).toBe(0);
		expect(applied).toEqual([1, 0]);
		advance(1000);
		expect(applied).toEqual([1, 0]);
	});

	test("motion during the countdown pushes the restore back", () => {
		cameraFrame(0);
		for (let index = 0; index < 3; index += 1) cameraFrame(50);
		advance(150);
		governor.motion();
		advance(150);
		expect(governor.tier).toBe(1);
		advance(100);
		expect(governor.tier).toBe(0);
	});

	test("dispose cancels the idle timer", () => {
		cameraFrame(0);
		for (let index = 0; index < 3; index += 1) cameraFrame(50);
		governor.dispose();
		advance(1000);
		expect(governor.tier).toBe(1);
	});
});
