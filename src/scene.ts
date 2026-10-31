import { Color } from "three";

import { EDGE_RENDER_ORDER, EDGE_SCENE_RENDER_ORDER } from "./edge-rendering";
import type {
	GraphraumAmbientOptions,
	GraphraumColor,
	GraphraumEdgeDepth,
	GraphraumMode,
	GraphraumSceneOptions,
	GraphraumShading,
	GraphraumSunOptions,
	ResolvedGraphraumSceneOptions,
} from "./types";

export const SCENE_DEFAULTS: ResolvedGraphraumSceneOptions = {
	edgeDepth: "behind-nodes",
	shading: "flat",
	sun: { azimuth: 220, elevation: 55, color: "#ffffff", intensity: 0.6 },
	ambient: { sky: "#ffffff", ground: "#a3a8b3", intensity: 0.55 },
};

/** One-line looks for `setScene`. Each sets the style and shared edge depth; sun and ambient keep their values. */
export const graphraumScenes = {
	flat: { shading: "flat", edgeDepth: "scene" },
	lit: { shading: "lit", edgeDepth: "scene" },
	toon: { shading: "toon", edgeDepth: "scene" },
} as const satisfies Record<GraphraumShading, GraphraumSceneOptions>;

const EDGE_DEPTHS: readonly GraphraumEdgeDepth[] = ["behind-nodes", "scene"];
const SHADINGS: readonly GraphraumShading[] = ["flat", "lit", "toon"];
const SCENE_KEYS: readonly string[] = ["edgeDepth", "shading", "sun", "ambient"];
const SUN_KEYS: readonly string[] = ["azimuth", "elevation", "color", "intensity"];
const AMBIENT_KEYS: readonly string[] = ["sky", "ground", "intensity"];
const SUN_ELEVATION_RANGE = [10, 85] as const;
const INTENSITY_RANGE = [0, 4] as const;
// Three.js only warns on strings it cannot parse; check the forms it understands without a DOM.
const CSS_COLOUR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|(rgb|rgba|hsl|hsla)\(.+\)|[a-z]+)$/i;

function oneOf<T extends string>(path: string, value: unknown, allowed: readonly T[]): T {
	const match = allowed.find((option) => option === value);
	if (match === undefined) {
		throw new Error(
			`${path} must be ${allowed.map((option) => `"${option}"`).join(" or ")}, got ${JSON.stringify(value)}.`,
		);
	}
	return match;
}

function assertObject(path: string, value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${path} must be an object.`);
	const unknown = Object.keys(value).find((key) => !keys.includes(key));
	if (unknown !== undefined) throw new Error(`Unknown ${path} option "${unknown}". Supported: ${keys.join(", ")}.`);
}

function finite(path: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${path} must be a finite number, got ${JSON.stringify(value)}.`);
	}
	return value;
}

function inRange(path: string, value: unknown, [min, max]: readonly [number, number]): number {
	const number = finite(path, value);
	if (number < min || number > max) throw new Error(`${path} must be ${min}..${max}, got ${number}.`);
	return number;
}

function colour(path: string, value: unknown): GraphraumColor {
	const valid =
		(typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff) ||
		(typeof value === "string" && CSS_COLOUR.test(value.trim()));
	if (!valid)
		throw new Error(`${path} must be a hex number or a CSS hex/rgb/hsl colour, got ${JSON.stringify(value)}.`);
	return value as GraphraumColor;
}

function resolveSun(options: GraphraumSunOptions | undefined, base: ResolvedGraphraumSceneOptions["sun"]) {
	if (options === undefined) return base;
	assertObject("scene.sun", options, SUN_KEYS);
	return {
		azimuth: options.azimuth === undefined ? base.azimuth : finite("scene.sun.azimuth", options.azimuth),
		elevation:
			options.elevation === undefined
				? base.elevation
				: inRange("scene.sun.elevation", options.elevation, SUN_ELEVATION_RANGE),
		color: options.color === undefined ? base.color : colour("scene.sun.color", options.color),
		intensity:
			options.intensity === undefined
				? base.intensity
				: inRange("scene.sun.intensity", options.intensity, INTENSITY_RANGE),
	};
}

function resolveAmbient(options: GraphraumAmbientOptions | undefined, base: ResolvedGraphraumSceneOptions["ambient"]) {
	if (options === undefined) return base;
	assertObject("scene.ambient", options, AMBIENT_KEYS);
	return {
		sky: options.sky === undefined ? base.sky : colour("scene.ambient.sky", options.sky),
		ground: options.ground === undefined ? base.ground : colour("scene.ambient.ground", options.ground),
		intensity:
			options.intensity === undefined
				? base.intensity
				: inRange("scene.ambient.intensity", options.intensity, INTENSITY_RANGE),
	};
}

/** Validates `options` and merges them onto `base`. Throws an actionable error for invalid values. */
export function resolveSceneOptions(
	options: GraphraumSceneOptions,
	base: ResolvedGraphraumSceneOptions = SCENE_DEFAULTS,
): ResolvedGraphraumSceneOptions {
	if (options === null || typeof options !== "object") throw new Error("Scene options must be an object.");
	const unknown = Object.keys(options).find((key) => !SCENE_KEYS.includes(key));
	if (unknown !== undefined) {
		throw new Error(`Unknown scene option "${unknown}". Supported: ${SCENE_KEYS.join(", ")}.`);
	}
	return {
		edgeDepth:
			options.edgeDepth === undefined ? base.edgeDepth : oneOf("scene.edgeDepth", options.edgeDepth, EDGE_DEPTHS),
		shading: options.shading === undefined ? base.shading : oneOf("scene.shading", options.shading, SHADINGS),
		sun: resolveSun(options.sun, base.sun),
		ambient: resolveAmbient(options.ambient, base.ambient),
	};
}

/** How the node and edge batches are configured for a mode and scene. */
export interface SceneDrawSetup {
	edgeDepthTest: boolean;
	edgeRenderOrder: number;
	nodeDepth: boolean;
	shading: GraphraumShading;
	sphereImpostors: boolean;
}

export function resolveSceneDrawSetup(mode: GraphraumMode, scene: ResolvedGraphraumSceneOptions): SceneDrawSetup {
	const sharedDepth = mode === "3d" && scene.edgeDepth === "scene";
	const shading = mode === "3d" ? scene.shading : "flat";
	return {
		edgeDepthTest: sharedDepth,
		edgeRenderOrder: sharedDepth ? EDGE_SCENE_RENDER_ORDER : EDGE_RENDER_ORDER,
		nodeDepth: mode === "3d",
		shading,
		// Lit spheres need the per-pixel surface; their depth is right even while edges stay behind.
		sphereImpostors: sharedDepth || shading !== "flat",
	};
}

/** Unit vector towards the sun in world space; y is up. */
export function sunDirection(azimuthDegrees: number, elevationDegrees: number): [number, number, number] {
	const azimuth = (azimuthDegrees * Math.PI) / 180;
	const elevation = (elevationDegrees * Math.PI) / 180;
	return [Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth)];
}

/** Linear light colours for the shader: colour times intensity. */
export function sceneLightColours(scene: ResolvedGraphraumSceneOptions) {
	const scaled = (value: GraphraumColor, intensity: number) => new Color(value).multiplyScalar(intensity);
	return {
		sun: scaled(scene.sun.color, scene.sun.intensity),
		sky: scaled(scene.ambient.sky, scene.ambient.intensity),
		ground: scaled(scene.ambient.ground, scene.ambient.intensity),
	};
}
