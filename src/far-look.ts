import type { GraphraumFarLookOptions } from "./types";

/** Peak strength of the far look at full effect. */
export const FAR_LOOK_STRENGTH = 0.2;
/** On-screen node width in CSS pixels at and above which the far look is off. */
export const FAR_LOOK_NEAR_PIXELS = 10;
/** On-screen node width in CSS pixels at and below which the far look is at full strength. */
export const FAR_LOOK_FAR_PIXELS = 3;
/** Share of a node colour moved toward its luminance at full effect on a light background. */
export const FAR_LOOK_LIGHT_MUTE = 0.3;
/** Share of a segment's width kept at full effect on a light background. */
export const FAR_LOOK_LIGHT_EDGE_WIDTH = 0.6;
/** Edge colour at full effect on a light background. */
export const FAR_LOOK_LIGHT_EDGE_COLOR = "#a3a3ad";
/** Half extent of a default node (`size` 4) in world units; edges follow a node of this size. */
export const FAR_LOOK_REFERENCE_NODE_EXTENT = 4;

/** Far look settings with every field present. */
export interface ResolvedFarLookOptions {
	readonly enabled: boolean;
	readonly farPixels: number;
	readonly nearPixels: number;
	readonly strength: number;
}

export const FAR_LOOK_DEFAULTS: ResolvedFarLookOptions = {
	enabled: true,
	farPixels: FAR_LOOK_FAR_PIXELS,
	nearPixels: FAR_LOOK_NEAR_PIXELS,
	strength: FAR_LOOK_STRENGTH,
};

/** Validates `options` (`false` turns the look off) and merges them onto `base`. Throws an actionable error. */
export function resolveFarLookOptions(
	options: GraphraumFarLookOptions | false,
	base: ResolvedFarLookOptions = FAR_LOOK_DEFAULTS,
): ResolvedFarLookOptions {
	if (options === false) return { ...base, enabled: false };
	const strength = options.strength ?? base.strength;
	const nearPixels = options.nearPixels ?? base.nearPixels;
	const farPixels = options.farPixels ?? base.farPixels;
	if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || strength > 1) {
		throw new Error(`Far look option strength must be a number from 0 to 1; received ${String(strength)}.`);
	}
	for (const [name, value] of [
		["nearPixels", nearPixels],
		["farPixels", farPixels],
	] as const) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new Error(`Far look option ${name} must be a positive finite number; received ${String(value)}.`);
		}
	}
	if (farPixels >= nearPixels) {
		throw new Error(`Far look option farPixels (${farPixels}) must be below nearPixels (${nearPixels}).`);
	}
	return { enabled: true, farPixels, nearPixels, strength };
}

/**
 * How far out a node of `nodePixels` on-screen width reads: 0 at and above `nearPixels`, 1 at and
 * below `farPixels`, a smoothstep between. The shaders compute the same curve per node.
 */
export function farLookAmount(nodePixels: number, nearPixels: number, farPixels: number): number {
	if (!(nodePixels < nearPixels)) return 0;
	if (nodePixels <= farPixels) return 1;
	const t = (nearPixels - nodePixels) / (nearPixels - farPixels);
	return t * t * (3 - 2 * t);
}

/** The look of a default-sized node at this scale; edges and the whole-view uniforms use it. */
export function referenceFarLookAmount(unitsPerPixel: number, options: ResolvedFarLookOptions): number {
	if (!options.enabled || !(unitsPerPixel > 0)) return 0;
	return farLookAmount((2 * FAR_LOOK_REFERENCE_NODE_EXTENT) / unitsPerPixel, options.nearPixels, options.farPixels);
}
