/** Default time a node added by a patch takes to grow in, in milliseconds. */
export const DEFAULT_ENTER_MS = 420;

/** How far past its size a growing node swells before it settles, as a share of the size. */
const OVERSHOOT = 1.4;

/**
 * Drawn size of a growing node, as a share of its size, at `progress` (0 to 1 over its enter time):
 * 0 before it starts, a short swell past 1 near the end, exactly 1 once done.
 */
export function enterScale(progress: number): number {
	if (progress <= 0) return 0;
	if (progress >= 1) return 1;
	const t = progress - 1;
	return 1 + (OVERSHOOT + 1) * t * t * t + OVERSHOOT * t * t;
}
