import { describe, expect, test } from "vitest";

import { EDGE_RENDER_ORDER } from "./edge-rendering";
import { NODE_RENDER_ORDER } from "./node-rendering";
import { resolveSceneDrawSetup, resolveSceneOptions, SCENE_DEFAULTS } from "./scene";
import type { GraphraumSceneOptions } from "./types";

describe("resolveSceneOptions", () => {
	test("defaults keep edges behind nodes", () => {
		expect(SCENE_DEFAULTS).toEqual({ edgeDepth: "behind-nodes" });
		expect(resolveSceneOptions({})).toEqual(SCENE_DEFAULTS);
	});

	test("merges a partial update onto the previous options", () => {
		const scene = resolveSceneOptions({ edgeDepth: "scene" });
		expect(scene).toEqual({ edgeDepth: "scene" });
		expect(resolveSceneOptions({}, scene)).toEqual({ edgeDepth: "scene" });
	});

	test("names the option and the allowed values for an invalid edge depth", () => {
		expect(() => resolveSceneOptions({ edgeDepth: "front" } as unknown as GraphraumSceneOptions)).toThrow(
			'scene.edgeDepth must be "behind-nodes" or "scene", got "front".',
		);
	});

	test("rejects unknown keys so a typo does not silently do nothing", () => {
		expect(() => resolveSceneOptions({ edgeDepht: "scene" } as unknown as GraphraumSceneOptions)).toThrow(
			'Unknown scene option "edgeDepht". Supported: edgeDepth.',
		);
	});

	test("rejects a non-object", () => {
		expect(() => resolveSceneOptions(null as unknown as GraphraumSceneOptions)).toThrow(
			"Scene options must be an object.",
		);
	});
});

describe("resolveSceneDrawSetup", () => {
	test("keeps today's layering unless edges share depth in 3D", () => {
		for (const mode of ["2d", "3d"] as const) {
			expect(resolveSceneDrawSetup(mode, { edgeDepth: "behind-nodes" })).toEqual({
				edgeDepthTest: false,
				edgeRenderOrder: EDGE_RENDER_ORDER,
				nodeDepth: mode === "3d",
				sphereImpostors: false,
			});
		}
	});

	test("ignores scene depth in 2D", () => {
		expect(resolveSceneDrawSetup("2d", { edgeDepth: "scene" })).toEqual({
			edgeDepthTest: false,
			edgeRenderOrder: EDGE_RENDER_ORDER,
			nodeDepth: false,
			sphereImpostors: false,
		});
	});

	test("draws edges after the depth-writing node impostors in 3D scene depth", () => {
		const setup = resolveSceneDrawSetup("3d", { edgeDepth: "scene" });
		expect(setup).toMatchObject({ edgeDepthTest: true, nodeDepth: true, sphereImpostors: true });
		expect(setup.edgeRenderOrder).toBeGreaterThan(NODE_RENDER_ORDER);
	});
});
