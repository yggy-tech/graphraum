import type { GraphraumFocusLensOptions } from "./types";

/** Focus lens settings with every field present. */
export interface ResolvedFocusLensOptions {
	readonly centerScale: number;
	readonly easing: number;
	readonly edgeScale: number;
	readonly enabled: boolean;
	readonly labelRamp: number;
	readonly labelThreshold: number;
	readonly reach: number;
}

/** Off by default: a graph keeps its drawn sizes until a host turns the lens on. */
export const FOCUS_LENS_DEFAULTS: ResolvedFocusLensOptions = {
	centerScale: 2,
	easing: 0.35,
	edgeScale: 0.75,
	enabled: false,
	labelRamp: 0.35,
	labelThreshold: 0.45,
	reach: 0.5,
};

/** The size factor and label opacity of one node under the lens. */
export interface FocusLensResult {
	/** 0..1. Opacity for the node's label. */
	labelAlpha: number;
	/** Multiplier for the node's drawn size. */
	scale: number;
}

function smoothstep(t: number): number {
	return t * t * (3 - 2 * t);
}

/**
 * Size factor for a node `distance` CSS pixels from the viewport center. The factor eases from
 * `centerScale` at the center to `edgeScale` at `reach * viewportMin` pixels and stays there beyond.
 * Allocation-free, so the renderer calls it for every visible node on every frame.
 */
export function focusLensScale(distance: number, viewportMin: number, options: ResolvedFocusLensOptions): number {
	const radius = options.reach * viewportMin;
	if (!(radius > 0) || !(distance > 0)) return distance > 0 ? options.edgeScale : options.centerScale;
	const t = Math.min(1, distance / radius);
	return options.edgeScale + (options.centerScale - options.edgeScale) * (1 - smoothstep(t));
}

/**
 * Label opacity for a node drawn at size factor `scale`. Labels appear once the factor passes
 * `1 + (centerScale - 1) * labelThreshold` and are fully opaque `(centerScale - 1) * labelRamp`
 * further up, so only nodes near the center are labelled. A lens that never enlarges
 * (`centerScale <= 1`) leaves labels alone.
 */
export function focusLensLabelAlpha(scale: number, options: ResolvedFocusLensOptions): number {
	const growth = options.centerScale - 1;
	if (!(growth > 0)) return 1;
	const alpha = (scale - (1 + growth * options.labelThreshold)) / (growth * options.labelRamp);
	return Math.min(1, Math.max(0, alpha));
}

/**
 * The lens for a node `distance` CSS pixels from the viewport center, in a viewport whose shorter
 * side is `viewportMin` pixels. Unset options take the defaults, except `enabled`, which this pure
 * function ignores.
 */
export function focusLens(
	distance: number,
	viewportMin: number,
	options: GraphraumFocusLensOptions = {},
): FocusLensResult {
	const resolved = resolveFocusLensOptions(options);
	const scale = focusLensScale(distance, viewportMin, resolved);
	return { labelAlpha: focusLensLabelAlpha(scale, resolved), scale };
}

function assertPositive(name: string, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Focus lens option ${name} must be a positive finite number; received ${String(value)}.`);
	}
}

function assertNonNegative(name: string, value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`Focus lens option ${name} must be a non-negative finite number; received ${String(value)}.`);
	}
}

/** Validates `options` and merges them onto `base`. Throws an actionable error for invalid values. */
export function resolveFocusLensOptions(
	options: GraphraumFocusLensOptions,
	base: ResolvedFocusLensOptions = FOCUS_LENS_DEFAULTS,
): ResolvedFocusLensOptions {
	const resolved = { ...base, ...stripUndefined(options) };
	if (typeof resolved.enabled !== "boolean") {
		throw new Error(`Focus lens option enabled must be a boolean; received ${String(resolved.enabled)}.`);
	}
	assertPositive("centerScale", resolved.centerScale);
	assertPositive("edgeScale", resolved.edgeScale);
	assertPositive("reach", resolved.reach);
	assertPositive("labelRamp", resolved.labelRamp);
	assertNonNegative("labelThreshold", resolved.labelThreshold);
	assertPositive("easing", resolved.easing);
	if (resolved.easing > 1) {
		throw new Error(`Focus lens option easing must be at most 1; received ${resolved.easing}.`);
	}
	return resolved;
}

function stripUndefined(options: GraphraumFocusLensOptions): GraphraumFocusLensOptions {
	return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}
