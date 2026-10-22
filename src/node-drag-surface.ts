import { type OrthographicCamera, type PerspectiveCamera, Plane, type Raycaster, Vector2, Vector3 } from "three";

import type { NodeDragSurface } from "./node-drag";
import type { GraphraumPosition } from "./types";

interface CanvasBounds {
	height: number;
	left: number;
	top: number;
	width: number;
}

export interface NodeDragSurfaceInput {
	anchor: GraphraumPosition;
	/** Read on every call, so a resize during a drag is followed. */
	bounds(): CanvasBounds;
	camera: OrthographicCamera | PerspectiveCamera;
	raycaster: Raycaster;
}

/**
 * Where the pointer is in world space on the plane a dragged node moves in. 2D unprojects onto the
 * view plane and reports no depth. 3D intersects the pointer ray with a plane through the anchor
 * that faces the camera as it was at the press, so the node keeps its depth and follows the pointer
 * across the screen. Returns `null` for an empty canvas, and from the surface when the ray misses.
 */
export function createNodeDragSurface({
	anchor,
	bounds,
	camera,
	raycaster,
}: NodeDragSurfaceInput): NodeDragSurface | null {
	const initial = bounds();
	if (initial.width === 0 || initial.height === 0) return null;
	const ndc = new Vector2();
	const toNdc = (clientX: number, clientY: number) => {
		const { height, left, top, width } = bounds();
		return ndc.set(((clientX - left) / width) * 2 - 1, -((clientY - top) / height) * 2 + 1);
	};

	if (camera.type === "OrthographicCamera") {
		return (clientX, clientY) => {
			const point = toNdc(clientX, clientY);
			const world = new Vector3(point.x, point.y, 0).unproject(camera);
			return { x: world.x, y: world.y };
		};
	}

	const plane = new Plane().setFromNormalAndCoplanarPoint(
		camera.getWorldDirection(new Vector3()),
		new Vector3(anchor.x, anchor.y, anchor.z ?? 0),
	);
	const hit = new Vector3();
	return (clientX, clientY) => {
		raycaster.setFromCamera(toNdc(clientX, clientY), camera);
		return raycaster.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y, z: hit.z } : null;
	};
}
