/**
 * The one on-screen scale of a 2D view: world units per CSS pixel. Culling, the density tier, edge
 * tiers, picking slop and the far look all read it, so a view framed by `fitView` (a wider or
 * narrower frustum at zoom 1) and the same view reached by wheel or pinch zoom (`camera.zoom`) give
 * the same answer. Never read the frustum on its own: it frames the graph only at zoom 1.
 */

/** The parts of an orthographic camera that decide the scale. */
export interface OrthographicFrame {
	bottom: number;
	left: number;
	right: number;
	top: number;
	zoom: number;
}

/** World units from the top to the bottom edge of the canvas, with the zoom applied. */
export function visibleWorldHeight(camera: Pick<OrthographicFrame, "bottom" | "top" | "zoom">): number {
	return (camera.top - camera.bottom) / camera.zoom;
}

/** World units from the left to the right edge of the canvas, with the zoom applied. */
export function visibleWorldWidth(camera: Pick<OrthographicFrame, "left" | "right" | "zoom">): number {
	return (camera.right - camera.left) / camera.zoom;
}

/** World units one CSS pixel covers. `canvasWidthPixels` is the canvas width in CSS pixels, at least 1. */
export function worldUnitsPerPixel(
	camera: Pick<OrthographicFrame, "left" | "right" | "zoom">,
	canvasWidthPixels: number,
): number {
	return visibleWorldWidth(camera) / Math.max(canvasWidthPixels, 1);
}

/** Size in CSS pixels of something `worldSize` units long. */
export function worldToPixels(worldSize: number, unitsPerPixel: number): number {
	return unitsPerPixel > 0 ? worldSize / unitsPerPixel : Number.POSITIVE_INFINITY;
}

/** Smallest on-screen width of a node the density tier draws, in CSS pixels, so far clusters never vanish. */
export const DENSITY_MIN_NODE_PIXELS = 2;

/**
 * Half extent in world units of a node the density tier draws: the cluster's own size, but never
 * under half of {@link DENSITY_MIN_NODE_PIXELS} on screen.
 */
export function densityNodeExtent(extent: number, unitsPerPixel: number): number {
	return Math.max(extent, (DENSITY_MIN_NODE_PIXELS / 2) * unitsPerPixel);
}
