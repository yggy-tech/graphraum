import { OrthographicCamera, PerspectiveCamera, Raycaster, Vector3 } from "three";
import { describe, expect, test } from "vitest";

import { createNodeDragSurface } from "./node-drag-surface";

const bounds = () => ({ height: 600, left: 100, top: 50, width: 800 });
const centre = { x: 100 + 400, y: 50 + 300 };

function orthographic(zoom = 1) {
	const camera = new OrthographicCamera(-400, 400, 300, -300, 0.1, 1000);
	camera.position.set(0, 0, 100);
	camera.zoom = zoom;
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();
	return camera;
}

function perspective() {
	const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 5000);
	camera.position.set(0, 0, 500);
	camera.lookAt(0, 0, 0);
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();
	return camera;
}

describe("createNodeDragSurface in 2D", () => {
	test("maps the canvas centre to the camera centre and has no depth", () => {
		const surface = createNodeDragSurface({
			anchor: { x: 0, y: 0 },
			bounds,
			camera: orthographic(),
			raycaster: new Raycaster(),
		});
		const point = surface?.(centre.x, centre.y);
		expect(point?.x).toBeCloseTo(0, 6);
		expect(point?.y).toBeCloseTo(0, 6);
		expect(point?.z).toBeUndefined();
	});

	test("one canvas pixel is one world unit at zoom 1 and y grows upwards", () => {
		const surface = createNodeDragSurface({
			anchor: { x: 0, y: 0 },
			bounds,
			camera: orthographic(),
			raycaster: new Raycaster(),
		});
		const point = surface?.(centre.x + 40, centre.y - 25);
		expect(point?.x).toBeCloseTo(40, 6);
		expect(point?.y).toBeCloseTo(25, 6);
	});

	test("zooming in makes a pixel cover fewer world units", () => {
		const surface = createNodeDragSurface({
			anchor: { x: 0, y: 0 },
			bounds,
			camera: orthographic(2),
			raycaster: new Raycaster(),
		});
		expect(surface?.(centre.x + 40, centre.y)?.x).toBeCloseTo(20, 6);
	});

	test("an empty canvas gives no surface", () => {
		expect(
			createNodeDragSurface({
				anchor: { x: 0, y: 0 },
				bounds: () => ({ height: 0, left: 0, top: 0, width: 800 }),
				camera: orthographic(),
				raycaster: new Raycaster(),
			}),
		).toBeNull();
	});
});

describe("createNodeDragSurface in 3D", () => {
	test("keeps the depth of the anchor plane while the pointer moves", () => {
		const anchor = { x: 30, y: -20, z: 60 };
		const surface = createNodeDragSurface({ anchor, bounds, camera: perspective(), raycaster: new Raycaster() });
		for (const [dx, dy] of [
			[0, 0],
			[120, 40],
			[-200, 90],
		]) {
			expect(surface?.(centre.x + (dx ?? 0), centre.y + (dy ?? 0))?.z).toBeCloseTo(60, 5);
		}
	});

	test("the pointer over the canvas centre lands on the view axis at the anchor depth", () => {
		const surface = createNodeDragSurface({
			anchor: { x: 30, y: -20, z: 60 },
			bounds,
			camera: perspective(),
			raycaster: new Raycaster(),
		});
		const point = surface?.(centre.x, centre.y);
		expect(point?.x).toBeCloseTo(0, 5);
		expect(point?.y).toBeCloseTo(0, 5);
	});

	test("a point further from the camera needs a larger world step for the same pixels", () => {
		const near = createNodeDragSurface({
			anchor: { x: 0, y: 0, z: 200 },
			bounds,
			camera: perspective(),
			raycaster: new Raycaster(),
		});
		const far = createNodeDragSurface({
			anchor: { x: 0, y: 0, z: -200 },
			bounds,
			camera: perspective(),
			raycaster: new Raycaster(),
		});
		const nearStep = near?.(centre.x + 100, centre.y)?.x ?? 0;
		const farStep = far?.(centre.x + 100, centre.y)?.x ?? 0;
		expect(farStep).toBeGreaterThan(nearStep);
	});

	test("the plane faces the camera, so an oblique view keeps the pointer under the node", () => {
		const camera = perspective();
		camera.position.set(300, 200, 400);
		camera.lookAt(0, 0, 0);
		camera.updateMatrixWorld();
		const anchor = new Vector3(20, 10, 0);
		const surface = createNodeDragSurface({ anchor, bounds, camera, raycaster: new Raycaster() });
		// The anchor projects to some canvas point; the surface must give the anchor back there.
		const ndc = anchor.clone().project(camera);
		const x = bounds().left + ((ndc.x + 1) / 2) * bounds().width;
		const y = bounds().top + ((1 - ndc.y) / 2) * bounds().height;
		const point = surface?.(x, y);
		expect(point?.x).toBeCloseTo(20, 4);
		expect(point?.y).toBeCloseTo(10, 4);
		expect(point?.z).toBeCloseTo(0, 4);
	});

	test("gives nothing when the plane cannot be hit", () => {
		const camera = perspective();
		const surface = createNodeDragSurface({ anchor: { x: 0, y: 0, z: 0 }, bounds, camera, raycaster: new Raycaster() });
		// Looking along the plane: shrink the field so the ray never meets it (a point behind the camera).
		camera.position.set(0, 0, -500);
		camera.lookAt(0, 0, -1000);
		camera.updateMatrixWorld();
		expect(surface?.(centre.x, centre.y)).toBeNull();
	});
});
