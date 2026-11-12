import type { GraphraumCameraState } from "./types";

const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const ease = (progress: number) => (progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2);

/** The camera pose between two poses of one mode at `progress` (0..1). 2D zooms by ratio, so the speed feels even. */
export function interpolateCamera(
	from: GraphraumCameraState,
	to: GraphraumCameraState,
	progress: number,
): GraphraumCameraState {
	const amount = ease(Math.min(Math.max(progress, 0), 1));
	if (from.mode === "2d" && to.mode === "2d") {
		return {
			center: { x: mix(from.center.x, to.center.x, amount), y: mix(from.center.y, to.center.y, amount) },
			mode: "2d",
			visibleHeight: from.visibleHeight * (to.visibleHeight / from.visibleHeight) ** amount,
		};
	}
	if (from.mode === "3d" && to.mode === "3d") {
		const point = (a: typeof from.position, b: typeof to.position) => ({
			x: mix(a.x, b.x, amount),
			y: mix(a.y, b.y, amount),
			z: mix(a.z, b.z, amount),
		});
		return { mode: "3d", position: point(from.position, to.position), target: point(from.target, to.target) };
	}
	return to;
}
