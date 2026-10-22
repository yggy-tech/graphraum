import { easeInOutCubic, flightProgress } from "./camera-flight";
import type { GraphraumDepthOfFieldOptions } from "./types";

export interface ResolvedDepthOfFieldOptions {
	readonly enabled: boolean;
	readonly focus: "selection" | number;
	readonly strength: number;
	readonly transitionMs: number;
}

export const DEPTH_OF_FIELD_DEFAULTS: ResolvedDepthOfFieldOptions = {
	enabled: false,
	focus: "selection",
	strength: 0.5,
	transitionMs: 400,
};

/** Blur radius in CSS pixels at strength 1 for a point at least `DEPTH_OF_FIELD_FALLOFF` away from the focal plane. */
export const DEPTH_OF_FIELD_MAX_BLUR_CSS_PIXELS = 12;
/**
 * Distance from the focal plane, as a fraction of the focal distance, at which the blur reaches its
 * maximum. Relative to the focal distance so the look does not depend on the graph's world units.
 */
export const DEPTH_OF_FIELD_FALLOFF = 0.5;
/** Below this blur radius in device pixels the passes are skipped and the frame renders directly. */
export const DEPTH_OF_FIELD_MIN_BLUR_PIXELS = 0.25;

/** Validates `options` and merges them onto `base`. Throws an actionable error for invalid values. */
export function resolveDepthOfFieldOptions(
	options: GraphraumDepthOfFieldOptions,
	base: ResolvedDepthOfFieldOptions = DEPTH_OF_FIELD_DEFAULTS,
): ResolvedDepthOfFieldOptions {
	if (typeof options !== "object" || options === null) {
		throw new Error("Depth of field options must be an object, e.g. { enabled: true, strength: 0.5 }.");
	}
	const enabled = options.enabled ?? base.enabled;
	const strength = options.strength ?? base.strength;
	const focus = options.focus ?? base.focus;
	const transitionMs = options.transitionMs ?? base.transitionMs;
	if (typeof enabled !== "boolean") {
		throw new Error(`Depth of field enabled must be a boolean; received ${String(enabled)}.`);
	}
	if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || strength > 1) {
		throw new Error(`Depth of field strength must be a number from 0 to 1; received ${String(strength)}.`);
	}
	if (focus !== "selection" && (typeof focus !== "number" || !Number.isFinite(focus) || focus <= 0)) {
		throw new Error(
			`Depth of field focus must be "selection" or a camera distance above 0 in world units; received ${String(focus)}.`,
		);
	}
	if (typeof transitionMs !== "number" || !Number.isFinite(transitionMs) || transitionMs < 0) {
		throw new Error(
			`Depth of field transitionMs must be a non-negative finite number of milliseconds; received ${String(transitionMs)}.`,
		);
	}
	return { enabled, focus, strength, transitionMs };
}

/** Largest blur radius in device pixels for a strength and pixel ratio. */
export function depthOfFieldMaxBlurPixels(strength: number, pixelRatio: number): number {
	return strength * DEPTH_OF_FIELD_MAX_BLUR_CSS_PIXELS * pixelRatio;
}

/**
 * Blur radius in device pixels for a surface at `distance` from the camera when the focal plane is at
 * `focusDistance`. Mirrors `blurRadius` in the depth-of-field shaders.
 */
export function circleOfConfusion(distance: number, focusDistance: number, maxBlurPixels: number): number {
	if (focusDistance <= 0) return 0;
	const offset = Math.abs(distance - focusDistance) / (focusDistance * DEPTH_OF_FIELD_FALLOFF);
	return maxBlurPixels * Math.min(offset, 1);
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

export interface FocusFrame {
	/** 0 is no blur, 1 is the configured strength. */
	readonly amount: number;
	/** World point on the focal plane, or null when there was never anything to focus. */
	readonly point: FocusPoint | null;
	/** False while a transition still needs frames. */
	readonly settled: boolean;
}

interface FocusTransition {
	readonly fromAmount: number;
	readonly fromPoint: FocusPoint | null;
	startMs: number | null;
}

/**
 * Animates the focus between selections. The focus is a world point rather than a depth, so the
 * selected nodes stay sharp while the camera moves and only a selection change animates. With no
 * target the blur fades out around the last focus point.
 */
export class DepthOfFieldFocus {
	private transition: FocusTransition | null = null;
	private lastAmount = 0;
	private lastPoint: FocusPoint | null = null;

	/** Starts a transition from the focus shown in the last frame, e.g. after a selection change. */
	retarget() {
		this.transition = {
			fromAmount: this.lastAmount,
			fromPoint: this.lastAmount > 0 ? this.lastPoint : null,
			startMs: null,
		};
	}

	/** Focus for the frame at `nowMs`. `jump` (reduced motion or a zero duration) skips the animation. */
	evaluate(nowMs: number, target: FocusPoint | null, durationMs: number, jump: boolean): FocusFrame {
		const transition = this.transition;
		const toAmount = target ? 1 : 0;
		let progress = 1;
		if (transition && !jump && durationMs > 0) {
			transition.startMs ??= nowMs;
			progress = flightProgress(nowMs - transition.startMs, durationMs);
		}
		const eased = easeInOutCubic(progress);
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
