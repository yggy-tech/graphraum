import { easeInOutCubic, flightProgress } from "./camera-flight";
import type { GraphraumDepthOfFieldOptions, GraphraumEasing } from "./types";

export type EasingFunction = (t: number) => number;

export interface ResolvedDepthOfFieldOptions {
	readonly enabled: boolean;
	readonly farDistance: number;
	readonly focus: "selection" | number;
	readonly maxBlur: number;
	readonly minBlur: number;
	readonly nearDistance: number;
	/** `null` follows `strength`. */
	readonly nearStrength: number | null;
	readonly strength: number;
	readonly transition: { readonly durationMs: number; readonly easing: GraphraumEasing };
}

export const DEPTH_OF_FIELD_DEFAULTS: ResolvedDepthOfFieldOptions = {
	enabled: false,
	farDistance: Number.POSITIVE_INFINITY,
	focus: "selection",
	maxBlur: 12,
	minBlur: 0,
	nearDistance: 0,
	nearStrength: null,
	strength: 0.5,
	transition: { durationMs: 400, easing: "easeInOut" },
};

/**
 * Blur radius in CSS pixels at strength 1 for a surface whose distance from the focal plane equals its
 * own distance from the camera (`|d - f| / d = 1`). Thin-lens style: the same world offset blurs more
 * the closer the camera is to the focus.
 */
export const DEPTH_OF_FIELD_APERTURE_CSS_PIXELS = 24;
/** Below this blur radius in device pixels the passes are skipped and the frame renders directly. */
export const DEPTH_OF_FIELD_MIN_BLUR_PIXELS = 0.25;

const EASINGS: Readonly<Record<Exclude<GraphraumEasing, EasingFunction>, EasingFunction>> = {
	easeIn: (t) => t * t * t,
	easeInOut: easeInOutCubic,
	easeOut: (t) => 1 - (1 - t) ** 3,
	linear: (t) => t,
};

export function resolveEasing(easing: GraphraumEasing): EasingFunction {
	return typeof easing === "function" ? easing : EASINGS[easing];
}

function isEasing(value: unknown): value is GraphraumEasing {
	return typeof value === "function" || (typeof value === "string" && Object.hasOwn(EASINGS, value));
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Validates `options` and merges them onto `base`. Throws an actionable error for invalid values. */
export function resolveDepthOfFieldOptions(
	options: GraphraumDepthOfFieldOptions,
	base: ResolvedDepthOfFieldOptions = DEPTH_OF_FIELD_DEFAULTS,
): ResolvedDepthOfFieldOptions {
	if (typeof options !== "object" || options === null) {
		throw new Error("Depth of field options must be an object, e.g. { enabled: true, strength: 0.5 }.");
	}
	if (options.transition !== undefined && (typeof options.transition !== "object" || options.transition === null)) {
		throw new Error('Depth of field transition must be an object, e.g. { durationMs: 400, easing: "easeInOut" }.');
	}
	const resolved: ResolvedDepthOfFieldOptions = {
		enabled: options.enabled ?? base.enabled,
		farDistance: options.farDistance ?? base.farDistance,
		focus: options.focus ?? base.focus,
		maxBlur: options.maxBlur ?? base.maxBlur,
		minBlur: options.minBlur ?? base.minBlur,
		nearDistance: options.nearDistance ?? base.nearDistance,
		nearStrength: options.nearStrength ?? base.nearStrength,
		strength: options.strength ?? base.strength,
		transition: {
			durationMs: options.transition?.durationMs ?? base.transition.durationMs,
			easing: options.transition?.easing ?? base.transition.easing,
		},
	};
	const { enabled, farDistance, focus, maxBlur, minBlur, nearDistance, nearStrength, strength, transition } = resolved;
	if (typeof enabled !== "boolean") {
		throw new Error(`Depth of field enabled must be a boolean; received ${String(enabled)}.`);
	}
	if (!isNonNegativeNumber(strength) || strength > 1) {
		throw new Error(`Depth of field strength must be a number from 0 to 1; received ${String(strength)}.`);
	}
	if (nearStrength !== null && (!isNonNegativeNumber(nearStrength) || nearStrength > 1)) {
		throw new Error(`Depth of field nearStrength must be a number from 0 to 1; received ${String(nearStrength)}.`);
	}
	if (focus !== "selection" && (typeof focus !== "number" || !Number.isFinite(focus) || focus <= 0)) {
		throw new Error(
			`Depth of field focus must be "selection" or a camera distance above 0 in world units; received ${String(focus)}.`,
		);
	}
	if (!isNonNegativeNumber(maxBlur) || !isNonNegativeNumber(minBlur) || minBlur > maxBlur) {
		throw new Error(
			`Depth of field minBlur and maxBlur must be non-negative CSS pixel radii with minBlur <= maxBlur; received ${String(minBlur)} and ${String(maxBlur)}.`,
		);
	}
	if (
		!isNonNegativeNumber(nearDistance) ||
		typeof farDistance !== "number" ||
		Number.isNaN(farDistance) ||
		farDistance <= nearDistance
	) {
		throw new Error(
			`Depth of field nearDistance must be a non-negative world distance below farDistance; received ${String(nearDistance)} and ${String(farDistance)}.`,
		);
	}
	if (!isNonNegativeNumber(transition.durationMs)) {
		throw new Error(
			`Depth of field transition durationMs must be a non-negative finite number of milliseconds; received ${String(transition.durationMs)}.`,
		);
	}
	if (!isEasing(transition.easing)) {
		throw new Error(
			`Depth of field transition easing must be "linear", "easeIn", "easeOut", "easeInOut" or a function; received ${String(transition.easing)}.`,
		);
	}
	return resolved;
}

/**
 * How much of `strength` applies when the focus is `focusDistance` from the camera: 1 up to
 * `nearDistance`, easing to 0 at `farDistance`, so a zoomed-out overview stays sharp.
 */
export function distanceFade(focusDistance: number, nearDistance: number, farDistance: number): number {
	if (focusDistance <= nearDistance) return 1;
	if (focusDistance >= farDistance) return 0;
	const t = (focusDistance - nearDistance) / (farDistance - nearDistance);
	return 1 - t * t * (3 - 2 * t);
}

export interface BlurRadiusParameters {
	/** Device pixels of blur per unit of `|d - f| / d`: strength, distance fade and pixel ratio applied. */
	aperturePixels: number;
	/** The same for surfaces in front of the focus, from `nearStrength`. */
	nearAperturePixels: number;
	maxBlurPixels: number;
	minBlurPixels: number;
}

/**
 * Thin-lens circle of confusion in device pixels for a surface at `distance` from the camera with the
 * focal plane at `focusDistance`: `aperture * |d - f| / d`, so surfaces in front of the focus blur
 * faster than those behind it, with the near aperture in front of the focus. Radii below the
 * minimum render sharp; the maximum clamps. Mirrors
 * `blurRadius` in the depth-of-field shaders.
 */
export function circleOfConfusion(distance: number, focusDistance: number, parameters: BlurRadiusParameters): number {
	if (focusDistance <= 0 || distance <= 0) return 0;
	const aperture = distance < focusDistance ? parameters.nearAperturePixels : parameters.aperturePixels;
	const radius = (aperture * Math.abs(distance - focusDistance)) / distance;
	return radius < parameters.minBlurPixels ? 0 : Math.min(radius, parameters.maxBlurPixels);
}

/**
 * Radius of the disk a pixel's own blur gathers from, in device pixels. Surfaces behind the focus
 * never blur past the aperture (`|d - f| / d < 1` there), so a pixel needs the full `maxBlurPixels`
 * reach only when its own radius is larger than that. Spreading the fixed taps over a disk no wider
 * than needed keeps a soft background densely sampled when `maxBlur` is set high for the
 * foreground. Mirrors `blurReach` in the depth-of-field blur shader.
 */
export function blurGatherRadius(centreRadius: number, parameters: BlurRadiusParameters): number {
	return Math.min(parameters.maxBlurPixels, Math.max(centreRadius, parameters.aperturePixels));
}

export interface FocusPoint {
	x: number;
	y: number;
	z: number;
}

/** Distance in front of the camera along its view axis, from a column-major view matrix (`matrixWorldInverse`). */
export function viewDistance(point: FocusPoint, viewMatrix: ArrayLike<number>): number {
	const m = (index: number) => viewMatrix[index] ?? 0;
	return -(m(2) * point.x + m(6) * point.y + m(10) * point.z + m(14));
}

/** Mean position of `points`, or null when there are none. */
export function meanPoint(points: Iterable<FocusPoint>): FocusPoint | null {
	let count = 0;
	const sum = { x: 0, y: 0, z: 0 };
	for (const point of points) {
		count += 1;
		sum.x += point.x;
		sum.y += point.y;
		sum.z += point.z;
	}
	return count === 0 ? null : { x: sum.x / count, y: sum.y / count, z: sum.z / count };
}

/**
 * A scalar animated toward a target. Retargeting starts from the value shown last, so an interrupted
 * transition continues smoothly instead of restarting. Each retarget returns a promise that resolves
 * `true` when the value arrives and `false` when another retarget or `cancel` replaces it.
 */
export class Tween {
	private from: number;
	private to: number;
	private value: number;
	private startMs: number | null = null;
	private durationMs = 0;
	private easing: EasingFunction = EASINGS.linear;
	private settle: ((arrived: boolean) => void) | null = null;

	constructor(value: number) {
		this.from = value;
		this.to = value;
		this.value = value;
	}

	get target() {
		return this.to;
	}

	get settled() {
		return this.settle === null && this.value === this.to;
	}

	retarget(to: number, durationMs: number, easing: EasingFunction): Promise<boolean> {
		this.settle?.(false);
		this.settle = null;
		this.from = this.value;
		this.to = to;
		this.startMs = null;
		this.durationMs = durationMs;
		this.easing = easing;
		if (durationMs === 0 || this.from === to) {
			this.value = to;
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			this.settle = resolve;
		});
	}

	/** Value at `nowMs`; the first sample after a retarget starts its clock. */
	sample(nowMs: number): number {
		if (this.settle === null) return this.value;
		this.startMs ??= nowMs;
		const progress = flightProgress(nowMs - this.startMs, this.durationMs);
		this.value = progress >= 1 ? this.to : this.from + (this.to - this.from) * this.easing(progress);
		if (progress >= 1) this.finish(true);
		return this.value;
	}

	/** Arrives at the target now, e.g. for reduced motion or when nothing renders the frames. */
	jump() {
		this.value = this.to;
		this.finish(true);
	}

	cancel() {
		this.finish(false);
	}

	private finish(arrived: boolean) {
		const settle = this.settle;
		this.settle = null;
		settle?.(arrived);
	}
}

export interface FocusFrame {
	/** 0 is no blur, 1 is the configured strength. */
	readonly amount: number;
	/** World point on the focal plane, or null when there was never anything to focus. */
	readonly point: FocusPoint | null;
	/** False while a transition still needs frames. */
	readonly settled: boolean;
}

interface FocusTransition {
	readonly durationMs: number;
	readonly easing: EasingFunction;
	readonly fromAmount: number;
	readonly fromPoint: FocusPoint | null;
	startMs: number | null;
}

/**
 * Animates the focus between selections. The focus is a world point rather than a depth, so its
 * distance is re-measured from the camera every frame and the selected nodes stay sharp while the
 * camera orbits, pans or zooms; only a selection change animates. With no target the blur fades out
 * around the last focus point. A retarget mid-transition continues from the focus shown last.
 */
export class DepthOfFieldFocus {
	private transition: FocusTransition | null = null;
	private lastAmount = 0;
	private lastPoint: FocusPoint | null = null;

	/** Starts a transition from the focus shown in the last frame, e.g. after a selection change. */
	retarget(durationMs: number, easing: EasingFunction) {
		this.transition = {
			durationMs,
			easing,
			fromAmount: this.lastAmount,
			fromPoint: this.lastAmount > 0 ? this.lastPoint : null,
			startMs: null,
		};
	}

	/** Focus for the frame at `nowMs`. `jump` (reduced motion) skips the animation. */
	evaluate(nowMs: number, target: FocusPoint | null, jump: boolean): FocusFrame {
		const transition = this.transition;
		const toAmount = target ? 1 : 0;
		let eased = 1;
		let progress = 1;
		if (transition && !jump && transition.durationMs > 0) {
			transition.startMs ??= nowMs;
			progress = flightProgress(nowMs - transition.startMs, transition.durationMs);
			eased = progress >= 1 ? 1 : transition.easing(progress);
		}
		const fromAmount = transition?.fromAmount ?? toAmount;
		const fromPoint = transition?.fromPoint ?? null;
		const amount = fromAmount + (toAmount - fromAmount) * eased;
		const point = target ? (fromPoint ? lerpPoint(fromPoint, target, eased) : target) : (fromPoint ?? this.lastPoint);
		const settled = progress >= 1;
		if (settled) this.transition = null;
		this.lastAmount = amount;
		this.lastPoint = point;
		return { amount, point, settled };
	}
}

function lerpPoint(from: FocusPoint, to: FocusPoint, t: number): FocusPoint {
	return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
}
