import { describe, expect, it } from "vitest";
import { createFixture } from "./benchmark";
import {
	measureFixtureLayoutStability,
	ProgressiveLayoutTimer,
	packIndexedForceEdges,
	progressiveForceBatchSize,
} from "./layout-benchmark";

describe("layout benchmark helpers", () => {
	it("packs node-N edge ids into a transferable index buffer", () => {
		expect(
			Array.from(
				packIndexedForceEdges([
					{ source: "node-0", target: "node-2" },
					{ source: "node-1", target: "node-3" },
				]),
			),
		).toEqual([0, 2, 1, 3]);
	});

	it("uses playground-sized progressive force batches", () => {
		expect(progressiveForceBatchSize(1_000)).toBe(1_000);
		expect(progressiveForceBatchSize(100_000)).toBe(12_500);
	});

	it("separates startup, transfer, compute, first useful frame, and complete", () => {
		const timer = new ProgressiveLayoutTimer(8, 4, 12);
		timer.markStart(100);
		timer.markStartup(5);
		timer.markTransfer(3);
		timer.recordAppliedBatch(140, 22);
		timer.recordAppliedBatch(155);
		expect(timer.complete(170)).toEqual({
			batchCount: 2,
			batchSize: 4,
			completeMilliseconds: 70,
			computeMilliseconds: 22,
			firstUsefulFrameMilliseconds: 40,
			iterations: 12,
			kind: "force",
			nodeCount: 8,
			startupMilliseconds: 5,
			transferMilliseconds: 3,
		});
	});

	it("counts a multilevel preview as the first useful frame and keeps the phases of the final batch", () => {
		const timer = new ProgressiveLayoutTimer(8, 4, 12);
		timer.markStart(100);
		timer.recordAppliedBatch(120);
		timer.recordAppliedBatch(150, 40, { coarsenMs: 5, coarsestMs: 6, levels: 3, refineMs: 20 });
		timer.recordAppliedBatch(160);
		const timing = timer.complete(170);
		expect(timing.firstUsefulFrameMilliseconds).toBe(20);
		expect(timing.computeMilliseconds).toBe(40);
		expect(timing.phases).toEqual({ coarsenMs: 5, coarsestMs: 6, levels: 3, refineMs: 20 });
	});

	it("rejects completion before the first useful batch", () => {
		const timer = new ProgressiveLayoutTimer(8, 4, 12);
		timer.markStart(0);
		expect(() => timer.complete(10)).toThrow(/without a useful position batch/);
	});

	it("reports seed stability next to the fixture, with its placebo", () => {
		const fixture = createFixture(120);
		const result = measureFixtureLayoutStability(120, fixture.edges);
		expect(result).toEqual(measureFixtureLayoutStability(120, fixture.edges));
		expect(result).toMatchObject({ nodeCount: 120, seeds: 5 });
		expect(result.overall).toBeGreaterThan(0);
		expect(result.overall).toBeLessThanOrEqual(1);
		expect(result.placeboOverall).toBeGreaterThan(0);
	});
});
