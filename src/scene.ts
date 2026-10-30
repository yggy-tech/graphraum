import { EDGE_RENDER_ORDER, EDGE_SCENE_RENDER_ORDER } from "./edge-rendering";
import type { GraphraumEdgeDepth, GraphraumMode, GraphraumSceneOptions, ResolvedGraphraumSceneOptions } from "./types";

export const SCENE_DEFAULTS: ResolvedGraphraumSceneOptions = { edgeDepth: "behind-nodes" };

const EDGE_DEPTHS: readonly GraphraumEdgeDepth[] = ["behind-nodes", "scene"];
const SCENE_KEYS: readonly string[] = ["edgeDepth"];

function isEdgeDepth(value: unknown): value is GraphraumEdgeDepth {
	return EDGE_DEPTHS.some((depth) => depth === value);
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
	const edgeDepth = options.edgeDepth ?? base.edgeDepth;
	if (!isEdgeDepth(edgeDepth)) {
		throw new Error(`scene.edgeDepth must be "behind-nodes" or "scene", got ${JSON.stringify(edgeDepth)}.`);
	}
	return { edgeDepth };
}

/** How the node and edge batches are configured for a mode and scene. */
export interface SceneDrawSetup {
	edgeDepthTest: boolean;
	edgeRenderOrder: number;
	nodeDepth: boolean;
	sphereImpostors: boolean;
}

export function resolveSceneDrawSetup(mode: GraphraumMode, scene: ResolvedGraphraumSceneOptions): SceneDrawSetup {
	const sharedDepth = mode === "3d" && scene.edgeDepth === "scene";
	return {
		edgeDepthTest: sharedDepth,
		edgeRenderOrder: sharedDepth ? EDGE_SCENE_RENDER_ORDER : EDGE_RENDER_ORDER,
		nodeDepth: mode === "3d",
		sphereImpostors: sharedDepth,
	};
}
