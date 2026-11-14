import { describe, expect, it } from "vitest";
import { enterScale } from "./enter-animation";

describe("enterScale", () => {
	it("is hidden before the start and exactly full when done", () => {
		expect(enterScale(-0.5)).toBe(0);
		expect(enterScale(0)).toBe(0);
		expect(enterScale(1)).toBe(1);
		expect(enterScale(2)).toBe(1);
	});

	it("grows, swells a little past full and settles", () => {
		expect(enterScale(0.25)).toBeGreaterThan(0);
		expect(enterScale(0.25)).toBeLessThan(enterScale(0.5));
		const peak = Math.max(...Array.from({ length: 99 }, (_, step) => enterScale((step + 1) / 100)));
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThan(1.15);
	});
});
