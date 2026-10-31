import { describe, expect, test } from "vitest";

import { EDGE_RENDER_ORDER } from "./edge-rendering";
import { NODE_RENDER_ORDER } from "./node-rendering";
import {
	graphraumScenes,
	resolveSceneDrawSetup,
	resolveSceneOptions,
	SCENE_DEFAULTS,
	sceneLightColours,
	sunDirection,
} from "./scene";
import type { GraphraumSceneOptions } from "./types";

const invalid = (options: unknown) => () => resolveSceneOptions(options as GraphraumSceneOptions);

describe("resolveSceneOptions", () => {
	test("defaults keep today's look: edges behind nodes, flat shading", () => {
		expect(SCENE_DEFAULTS).toMatchObject({ edgeDepth: "behind-nodes", shading: "flat" });
		expect(resolveSceneOptions({})).toEqual(SCENE_DEFAULTS);
	});

	test("merges a partial update onto the previous options", () => {
		const scene = resolveSceneOptions({ edgeDepth: "scene" });
		expect(scene).toEqual({ ...SCENE_DEFAULTS, edgeDepth: "scene" });
		expect(resolveSceneOptions({}, scene)).toEqual(scene);
	});

	test("merges sun and ambient field by field", () => {
		const scene = resolveSceneOptions({ shading: "lit", sun: { azimuth: 90 }, ambient: { intensity: 1 } });
		expect(scene.sun).toEqual({ ...SCENE_DEFAULTS.sun, azimuth: 90 });
		expect(scene.ambient).toEqual({ ...SCENE_DEFAULTS.ambient, intensity: 1 });
		const next = resolveSceneOptions({ sun: { elevation: 30 } }, scene);
		expect(next.sun).toEqual({ ...SCENE_DEFAULTS.sun, azimuth: 90, elevation: 30 });
		expect(next.shading).toBe("lit");
	});

	test("names the option and the allowed values for invalid choices", () => {
		expect(invalid({ edgeDepth: "front" })).toThrow('scene.edgeDepth must be "behind-nodes" or "scene", got "front".');
		expect(invalid({ shading: "pbr" })).toThrow('scene.shading must be "flat" or "lit" or "toon", got "pbr".');
	});

	test("names the option and the range for numbers out of range", () => {
		expect(invalid({ sun: { elevation: 120 } })).toThrow("scene.sun.elevation must be 10..85, got 120.");
		expect(invalid({ sun: { intensity: -1 } })).toThrow("scene.sun.intensity must be 0..4, got -1.");
		expect(invalid({ ambient: { intensity: 5 } })).toThrow("scene.ambient.intensity must be 0..4, got 5.");
		expect(invalid({ sun: { azimuth: Number.NaN } })).toThrow("scene.sun.azimuth must be a finite number, got null.");
	});

	test("rejects colours three.js cannot read", () => {
		expect(invalid({ sun: { color: "#12345" } })).toThrow(
			'scene.sun.color must be a hex number or a CSS hex/rgb/hsl colour, got "#12345".',
		);
		expect(invalid({ ambient: { sky: -1 } })).toThrow("scene.ambient.sky must be");
		expect(resolveSceneOptions({ ambient: { ground: "rgb(10, 20, 30)", sky: 0xffeedd } }).ambient).toMatchObject({
			ground: "rgb(10, 20, 30)",
			sky: 0xffeedd,
		});
	});

	test("rejects unknown keys so a typo does not silently do nothing", () => {
		expect(invalid({ edgeDepht: "scene" })).toThrow(
			'Unknown scene option "edgeDepht". Supported: edgeDepth, shading, sun, ambient.',
		);
		expect(invalid({ sun: { height: 30 } })).toThrow(
			'Unknown scene.sun option "height". Supported: azimuth, elevation, color, intensity.',
		);
		expect(invalid({ ambient: [] })).toThrow("scene.ambient must be an object.");
	});

	test("rejects a non-object", () => {
		expect(invalid(null)).toThrow("Scene options must be an object.");
	});

	test("presets set the style with shared depth and keep the light", () => {
		const custom = resolveSceneOptions({ sun: { azimuth: 10 } });
		for (const shading of ["flat", "lit", "toon"] as const) {
			const scene = resolveSceneOptions(graphraumScenes[shading], custom);
			expect(scene).toMatchObject({ shading, edgeDepth: "scene" });
			expect(scene.sun.azimuth).toBe(10);
		}
	});
});

describe("resolveSceneDrawSetup", () => {
	test("keeps today's layering unless edges share depth in 3D", () => {
		for (const mode of ["2d", "3d"] as const) {
			expect(resolveSceneDrawSetup(mode, SCENE_DEFAULTS)).toEqual({
				edgeDepthTest: false,
				edgeRenderOrder: EDGE_RENDER_ORDER,
				nodeDepth: mode === "3d",
				shading: "flat",
				sphereImpostors: false,
			});
		}
	});

	test("ignores scene depth and shading in 2D", () => {
		expect(resolveSceneDrawSetup("2d", resolveSceneOptions(graphraumScenes.lit))).toEqual({
			edgeDepthTest: false,
			edgeRenderOrder: EDGE_RENDER_ORDER,
			nodeDepth: false,
			shading: "flat",
			sphereImpostors: false,
		});
	});

	test("draws edges after the depth-writing node impostors in 3D scene depth", () => {
		const setup = resolveSceneDrawSetup("3d", resolveSceneOptions({ edgeDepth: "scene" }));
		expect(setup).toMatchObject({ edgeDepthTest: true, nodeDepth: true, sphereImpostors: true, shading: "flat" });
		expect(setup.edgeRenderOrder).toBeGreaterThan(NODE_RENDER_ORDER);
	});

	test("lit nodes are spheres even while edges stay behind them", () => {
		const setup = resolveSceneDrawSetup("3d", resolveSceneOptions({ shading: "toon" }));
		expect(setup).toMatchObject({ edgeDepthTest: false, sphereImpostors: true, shading: "toon" });
		expect(setup.edgeRenderOrder).toBe(EDGE_RENDER_ORDER);
	});
});

describe("sun and light", () => {
	test("elevation lifts the sun, azimuth turns it around the vertical axis", () => {
		const [x, y, z] = sunDirection(90, 0);
		expect(x).toBeCloseTo(1);
		expect(y).toBeCloseTo(0);
		expect(z).toBeCloseTo(0);
		expect(sunDirection(0, 90)[1]).toBeCloseTo(1);
		expect(Math.hypot(...sunDirection(220, 55))).toBeCloseTo(1);
	});

	test("light colours are scaled by their intensity", () => {
		const scene = resolveSceneOptions({ sun: { color: "#ffffff", intensity: 2 }, ambient: { intensity: 0 } });
		const lights = sceneLightColours(scene);
		expect(lights.sun.r).toBeCloseTo(2);
		expect(lights.sky.r).toBe(0);
		expect(lights.ground.g).toBe(0);
	});
});
