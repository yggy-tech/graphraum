import { afterEach, describe, expect, test } from "vitest";

import { mountGraph, unmountGraphs } from "./test-support/browser-harness";
import type { GraphraumCameraState, GraphraumData } from "./types";

afterEach(() => unmountGraphs());

const NODE_COUNT = 400;

function ring(): GraphraumData {
	return {
		nodes: Array.from({ length: NODE_COUNT }, (_, index) => ({
			id: `n${index}`,
			position: { x: Math.cos(index) * 100, y: Math.sin(index) * 100, z: (index % 20) * 5 },
		})),
		edges: Array.from({ length: NODE_COUNT * 2 }, (_, index) => ({
			id: `e${index}`,
			source: `n${index % NODE_COUNT}`,
			target: `n${(index * 7 + 3) % NODE_COUNT}`,
		})),
	};
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("interaction quality in real WebGL2", () => {
	test("lowers the tier while the camera moves slowly and restores it at rest", async () => {
		// A target no frame can meet makes every camera frame slow, whatever this machine does.
		const graph = mountGraph(
			{ interactionQuality: { enabled: true, idleMs: 120, targetFrameMs: 0.001 }, maxVisibleEdges: 400, mode: "3d" },
			ring(),
		);
		await nextFrame();
		const before = graph.getDiagnostics();
		expect(before.interactionQuality).toBe("full");
		expect(before.visibleEdges).toBe(400);

		const start = graph.getCameraState();
		if (start.mode !== "3d") throw new Error("expected a 3D camera");
		for (let step = 1; step <= 14; step += 1) {
			const moved: GraphraumCameraState = { ...start, position: { ...start.position, x: start.position.x + step } };
			graph.setCameraState(moved);
			await nextFrame();
		}
		const moving = graph.getDiagnostics();
		expect(moving.interactionQuality).not.toBe("full");
		expect(moving.visibleEdges).toBeLessThan(before.visibleEdges);
		expect(moving.gpuDrawCalls).toBe(before.gpuDrawCalls);
		expect(moving.totalEdges).toBe(before.totalEdges);

		await wait(400);
		const rested = graph.getDiagnostics();
		expect(rested.interactionQuality).toBe("full");
		expect(rested.visibleEdges).toBe(before.visibleEdges);
		expect(rested.visibleNodes).toBe(before.visibleNodes);
	});

	test("stays at full quality when it is off", async () => {
		const graph = mountGraph({ mode: "3d" }, ring());
		const start = graph.getCameraState();
		if (start.mode !== "3d") throw new Error("expected a 3D camera");
		for (let step = 1; step <= 10; step += 1) {
			graph.setCameraState({ ...start, position: { ...start.position, x: start.position.x + step } });
			await nextFrame();
		}
		expect(graph.getDiagnostics().interactionQuality).toBe("full");
	});

	test("turning it off restores full quality at once", async () => {
		const graph = mountGraph(
			{ interactionQuality: { enabled: true, idleMs: 5_000, targetFrameMs: 0.001 }, maxVisibleEdges: 400, mode: "3d" },
			ring(),
		);
		const start = graph.getCameraState();
		if (start.mode !== "3d") throw new Error("expected a 3D camera");
		for (let step = 1; step <= 14; step += 1) {
			graph.setCameraState({ ...start, position: { ...start.position, x: start.position.x + step } });
			await nextFrame();
		}
		expect(graph.getDiagnostics().interactionQuality).not.toBe("full");
		graph.setInteractionQuality({ enabled: false });
		await nextFrame();
		expect(graph.getDiagnostics().interactionQuality).toBe("full");
		expect(graph.getDiagnostics().visibleEdges).toBe(400);
	});

	test("2D leaves density clusters when full quality returns", async () => {
		// 380 of 400 nodes sit inside the hysteresis band: clusters stay on at full quality only if they were on.
		const data: GraphraumData = {
			nodes: Array.from({ length: 380 }, (_, index) => ({
				id: `n${index}`,
				position: { x: (index % 20) * 10, y: Math.floor(index / 20) * 10 },
			})),
			edges: [],
		};
		const graph = mountGraph(
			{ interactionQuality: { enabled: true, idleMs: 120, targetFrameMs: 0.001 }, maxVisibleNodes: 400 },
			data,
		);
		await nextFrame();
		expect(graph.getDiagnostics().aggregatedNodeClusters).toBe(0);
		const start = graph.getCameraState();
		if (start.mode !== "2d") throw new Error("expected a 2D camera");
		for (let step = 1; step <= 14; step += 1) {
			graph.setCameraState({ ...start, center: { x: start.center.x + step * 0.01, y: start.center.y } });
			await nextFrame();
		}
		expect(graph.getDiagnostics().interactionQuality).not.toBe("full");
		expect(graph.getDiagnostics().aggregatedNodeClusters).toBeGreaterThan(0);
		await wait(400);
		const rested = graph.getDiagnostics();
		expect(rested.interactionQuality).toBe("full");
		expect(rested.aggregatedNodeClusters).toBe(0);
		expect(rested.visibleNodes).toBe(380);
	});
});
