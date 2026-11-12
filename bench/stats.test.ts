import { describe, expect, test } from "vitest";

import { aggregateCase, buildReport, renderMarkdown } from "./report";
import { crossing, fitLogLog, isScalingFile, SCALING_SCHEMA, type ScalingFile } from "./scaling";
import { renderScalingHtml } from "./scaling-html";
import { aggregate, shuffle } from "./stats";
import type { BenchEnvironment, CaseDescriptor } from "./types";

describe("aggregate", () => {
	test("reports median, p95, min, max and n", () => {
		const stats = aggregate([5, 1, 3, 2, 4]);
		expect(stats).toMatchObject({ max: 5, median: 3, min: 1, n: 5, nullCount: 0, p95: 5 });
	});

	test("counts null samples instead of averaging them in", () => {
		const stats = aggregate([null, 2, null, 4]);
		expect(stats).toMatchObject({ median: 2, n: 2, nullCount: 2 });
		expect(aggregate([null, null])).toMatchObject({ median: null, n: 0, nullCount: 2 });
	});
});

describe("shuffle", () => {
	test("is a deterministic permutation per seed", () => {
		const items = Array.from({ length: 30 }, (_, index) => index);
		expect(shuffle(items, 7)).toEqual(shuffle(items, 7));
		expect(shuffle(items, 7).toSorted((a, b) => a - b)).toEqual(items);
		expect(shuffle(items, 7)).not.toEqual(shuffle(items, 8));
		expect(shuffle(items, 7)).not.toEqual(items);
	});
});

const descriptor: CaseDescriptor = {
	edges: 30,
	group: "frame",
	id: "frame-2d-10",
	mode: "2d",
	nodes: 10,
	protocol: "protocol text",
	title: "Pan and zoom 10",
};
const environment: BenchEnvironment = {
	devicePixelRatio: 1,
	glRenderer: "ANGLE (Google, Vulkan, SwiftShader)",
	glVendor: "Google Inc.",
	gpuTimer: false,
	maxPixelRatio: 1,
	softwareRenderer: true,
	userAgent: "test",
	viewport: { height: 600, width: 800 },
};

describe("report", () => {
	const runs = [
		{ cold: { constructMs: 10 }, warm: { cpuMs: [1, 2], gpuMs: [null, null], stepMs: [1, 1] } },
		{ cold: { constructMs: 30 }, warm: { cpuMs: [3, 4], gpuMs: [null, null], stepMs: [1, 1] } },
	];

	test("pools warm samples across runs and keeps one cold value per run", () => {
		const { metrics } = aggregateCase({ descriptor, runs });
		expect(metrics.find((item) => item.metric === "constructMs")?.stats).toMatchObject({ n: 2, median: 10, max: 30 });
		expect(metrics.find((item) => item.metric === "cpuMs")?.stats).toMatchObject({ n: 4, max: 4, min: 1 });
		expect(metrics.find((item) => item.metric === "gpuMs")?.stats).toMatchObject({ n: 0, nullCount: 4 });
	});

	test("renders GPU as n/a without the timer and states the renderer", () => {
		const markdown = renderMarkdown(
			buildReport({
				browserVersion: "Chromium test",
				cases: [{ descriptor, runs }],
				commit: "abc1234",
				environment,
				generatedAt: "2026-01-01T00:00:00.000Z",
				order: ["frame-2d-10#1", "frame-2d-10#2"],
				runs: 2,
				seed: 1,
				launchArgs: ["--use-angle=swiftshader"],
			}),
		);
		expect(markdown).toContain("SwiftShader");
		expect(markdown).toContain("machine-specific");
		expect(markdown).toContain("| Pan and zoom 10 | 2D | 10 / 30 |");
		expect(markdown).toContain("n/a");
	});
});

describe("scaling", () => {
	const linear = [1_000, 10_000, 100_000].map((nodes) => ({ median: nodes / 1_000, nodes }));

	test("fits the scaling exponent on a log-log line", () => {
		expect(fitLogLog(linear)?.exponent).toBeCloseTo(1, 6);
		expect(fitLogLog([{ median: 5, nodes: 10 }])).toBeNull();
		expect(
			fitLogLog([
				{ median: null, nodes: 10 },
				{ median: 2, nodes: 20 },
			]),
		).toBeNull();
	});

	test("finds where the median crosses the frame budget", () => {
		const cross = crossing(linear, 16.7);
		expect(cross?.kind).toBe("interpolated");
		expect(cross?.nodes).toBeCloseTo(16_700, 0);
		expect(crossing(linear, 1_000)).toBeNull();
		expect(crossing(linear, 0.5)).toMatchObject({ kind: "always", nodes: 1_000 });
	});

	test("the HTML report embeds the data and the fit code, with no network references", () => {
		const file: ScalingFile = {
			commit: "abc",
			environment: { glRenderer: "r", gpuTimer: false, softwareRenderer: true, userAgent: "u" },
			generatedAt: "2026-01-01",
			label: "base</script>",
			runs: 1,
			schema: SCALING_SCHEMA,
			series: [
				{
					id: "pan2d",
					points: linear.map((point) => ({ ...point, edges: point.nodes * 3, max: 1, min: 1, n: 1, p95: 1 })),
					title: "t",
					unit: "ms",
				},
			],
		};
		const html = renderScalingHtml([file, file]);
		expect(html).toContain("function fitLogLog");
		expect(html).toContain("function crossing");
		expect(html).not.toContain("base</script>");
		expect(html.replace("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//);
		expect(isScalingFile(file)).toBe(true);
	});
});
