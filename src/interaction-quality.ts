import type { GraphraumInteractionQuality, GraphraumInteractionQualityOptions } from "./types";

/** Interaction quality settings with every field present. */
export interface ResolvedInteractionQualityOptions {
	readonly enabled: boolean;
	readonly idleMs: number;
	readonly targetFrameMs: number;
}

/** Off by default: a host opts in. 25 ms is a little under 40 frames per second. */
export const INTERACTION_QUALITY_DEFAULTS: ResolvedInteractionQualityOptions = {
	enabled: false,
	idleMs: 200,
	targetFrameMs: 25,
};

/** Tier 0 is full quality. Higher tiers scale the pixel ratio and the visible node and edge budgets. */
export const INTERACTION_TIERS: readonly { budget: number; name: GraphraumInteractionQuality; pixelRatio: number }[] = [
	{ budget: 1, name: "full", pixelRatio: 1 },
	{ budget: 0.5, name: "reduced", pixelRatio: 0.75 },
	{ budget: 0.25, name: "minimal", pixelRatio: 0.5 },
];

/** A frame counts as slow above this multiple of the target; the margin keeps jitter from counting. */
const SLOW_FACTOR = 1.2;
/** Consecutive slow frames before the tier drops one step. */
const SLOW_FRAMES_TO_DEGRADE = 3;

/** Validates `options` and merges them onto `base`. Throws an actionable error for invalid values. */
export function resolveInteractionQualityOptions(
	options: GraphraumInteractionQualityOptions,
	base: ResolvedInteractionQualityOptions = INTERACTION_QUALITY_DEFAULTS,
): ResolvedInteractionQualityOptions {
	const defined = Object.entries(options).filter(([, value]) => value !== undefined);
	const resolved = { ...base, ...Object.fromEntries(defined) };
	if (typeof resolved.enabled !== "boolean") {
		throw new Error(`Interaction quality option enabled must be a boolean; received ${String(resolved.enabled)}.`);
	}
	for (const name of ["idleMs", "targetFrameMs"] as const) {
		const value: unknown = resolved[name];
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			throw new Error(
				`Interaction quality option ${name} must be a positive finite number; received ${String(value)}.`,
			);
		}
	}
	return resolved;
}

/** A budget scaled for `tier`, never below 1. */
export function scaledBudget(maximum: number, tier: number): number {
	return Math.max(1, Math.floor(maximum * (INTERACTION_TIERS[tier]?.budget ?? 1)));
}

/** The pixel ratio for `tier` given the full-quality ratio. */
export function scaledPixelRatio(pixelRatio: number, tier: number): number {
	return pixelRatio * (INTERACTION_TIERS[tier]?.pixelRatio ?? 1);
}

/** The tier after one camera frame that took `frameMs`, with the running count of slow frames. */
export function nextInteractionTier(
	state: { slowFrames: number; tier: number },
	frameMs: number,
	targetFrameMs: number,
): { slowFrames: number; tier: number } {
	if (frameMs <= targetFrameMs * SLOW_FACTOR) return { slowFrames: 0, tier: state.tier };
	const slowFrames = state.slowFrames + 1;
	if (slowFrames < SLOW_FRAMES_TO_DEGRADE || state.tier >= INTERACTION_TIERS.length - 1) {
		return { slowFrames, tier: state.tier };
	}
	return { slowFrames: 0, tier: state.tier + 1 };
}

/**
 * Lowers the tier while the camera moves and frames run slow, and restores tier 0 once the camera
 * has rested for `idleMs`. The tier only rises during motion, so it cannot oscillate; a rest is the
 * only way back. The host supplies the clock and applies the tier; this class owns the counters
 * and the one idle timer, which re-arms itself instead of restarting on every camera change.
 */
export class InteractionQualityGovernor {
	tier = 0;
	slowFrames = 0;
	private lastFrameMs: number | null = null;
	private moved = false;
	/** True when a camera change came in since the idle timer last looked. */
	private motionSeen = false;
	private lastMotionMs = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly options: ResolvedInteractionQualityOptions,
		private readonly apply: () => void,
		private readonly now: () => number = () => performance.now(),
	) {}

	/** Call on every camera change. */
	motion() {
		this.moved = true;
		this.lastMotionMs = this.now();
		if (this.timer === null) {
			this.motionSeen = false;
			this.timer = setTimeout(this.checkIdle, this.options.idleMs);
		} else {
			this.motionSeen = true;
		}
	}

	/** Call at the start of every rendered frame. Only frames that follow a camera change are timed. */
	frame() {
		const nowMs = this.now();
		const previous = this.lastFrameMs;
		this.lastFrameMs = this.moved ? nowMs : null;
		this.moved = false;
		if (previous === null || this.lastFrameMs === null) return;
		// A pause in the input is not a slow frame: the idle check below clears `lastFrameMs` after `idleMs`.
		const next = nextInteractionTier(this, nowMs - previous, this.options.targetFrameMs);
		this.slowFrames = next.slowFrames;
		if (next.tier !== this.tier) this.setTier(next.tier);
	}

	dispose() {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	private setTier(tier: number) {
		this.tier = tier;
		this.slowFrames = 0;
		// The frame that pays for the new tier is not a fair sample.
		this.lastFrameMs = null;
		this.apply();
	}

	private readonly checkIdle = () => {
		this.timer = null;
		const remaining = this.lastMotionMs + this.options.idleMs - this.now();
		const seen = this.motionSeen;
		this.motionSeen = false;
		// A busy main thread can run this late with input still queued: wait one more period.
		if (remaining > 0 || seen) {
			this.timer = setTimeout(this.checkIdle, remaining > 0 ? remaining : this.options.idleMs);
			return;
		}
		this.slowFrames = 0;
		this.lastFrameMs = null;
		if (this.tier !== 0) this.setTier(0);
	};
}
