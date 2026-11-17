import { OrthographicCamera } from "three";
import { describe, expect, test } from "vitest";

import {
	DENSITY_MIN_NODE_PIXELS,
	densityNodeExtent,
	visibleWorldHeight,
	worldToPixels,
	worldUnitsPerPixel,
} from "./view-scale";

/** A frustum showing `height` world units at zoom 1, like `setOrthographicFrustum`. */
function frame(height: number, aspect: number, zoom: number) {
	const camera = new OrthographicCamera((-height * aspect) / 2, (height * aspect) / 2, height / 2, -height / 2);
	camera.zoom = zoom;
	return camera;
}

describe("world units per pixel", () => {
	test("is the visible width over the canvas width", () => {
		expect(worldUnitsPerPixel(frame(600, 2, 1), 1200)).toBeCloseTo(1);
		expect(worldUnitsPerPixel(frame(300, 2, 1), 1200)).toBeCloseTo(0.5);
	});

	test("a fit frustum and a wheel zoom framing the same world give the same scale", () => {
		const fit = frame(1000, 1.6, 1);
		const zoomedOut = frame(250, 1.6, 0.25);
		expect(visibleWorldHeight(zoomedOut)).toBeCloseTo(1000);
		expect(worldUnitsPerPixel(zoomedOut, 800)).toBeCloseTo(worldUnitsPerPixel(fit, 800));
	});

	test("zooming in halves the world a pixel covers", () => {
		const camera = frame(1000, 1, 1);
		const before = worldUnitsPerPixel(camera, 500);
		camera.zoom = 2;
		expect(worldUnitsPerPixel(camera, 500)).toBeCloseTo(before / 2);
	});

	test("a canvas of no width counts as one pixel", () => {
		expect(worldUnitsPerPixel(frame(10, 1, 1), 0)).toBeCloseTo(10);
	});
});

describe("pixel sizes", () => {
	test("converts a world size to pixels", () => {
		expect(worldToPixels(8, 2)).toBe(4);
		expect(worldToPixels(8, 0)).toBe(Number.POSITIVE_INFINITY);
	});

	test("a density node keeps its size up close and never draws under the pixel floor", () => {
		expect(densityNodeExtent(6, 0.1)).toBe(6);
		const far = densityNodeExtent(6, 50);
		expect(far).toBeCloseTo((DENSITY_MIN_NODE_PIXELS / 2) * 50);
		expect(worldToPixels(2 * far, 50)).toBeCloseTo(DENSITY_MIN_NODE_PIXELS);
	});
});
