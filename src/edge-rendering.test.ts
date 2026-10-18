import { type InstancedBufferAttribute, PerspectiveCamera, Vector3 } from "three";
import { describe, expect, test } from "vitest";

import {
	createEdgeGeometry,
	createEdgeMaterial,
	markerApexInView,
	trimViewSegment,
	writeEdgeMarkerInstance,
	writeEdgeSegmentInstance,
} from "./edge-rendering";

describe("edge rendering buffers", () => {
	test("never tests or writes depth, so nodes drawn after it always cover it", () => {
		const material = createEdgeMaterial();

		expect(material.vertexShader).toContain("attribute vec3 instanceEndA;");
		expect(material.depthTest).toBe(false);
		expect(material.depthWrite).toBe(false);
		material.dispose();
	});

	test("creates all instanced attributes at the requested capacity", () => {
		const geometry = createEdgeGeometry(4);
		for (const name of [
			"instanceKind",
			"instanceEndA",
			"instanceEndB",
			"instanceColor",
			"instanceWidth",
			"instanceStyle",
		]) {
			const attribute = geometry.getAttribute(name) as InstancedBufferAttribute;
			expect(attribute).toBeDefined();
			expect(attribute.count).toBe(4);
		}
		geometry.dispose();
	});
});

describe("edge-rendering attributes", () => {
	test("writes segment endpoints and style codes", () => {
		const geometry = createEdgeGeometry(2);
		const kind = geometry.getAttribute("instanceKind") as InstancedBufferAttribute;
		const a = geometry.getAttribute("instanceEndA") as InstancedBufferAttribute;
		const b = geometry.getAttribute("instanceEndB") as InstancedBufferAttribute;
		const color = geometry.getAttribute("instanceColor") as InstancedBufferAttribute;
		const width = geometry.getAttribute("instanceWidth") as InstancedBufferAttribute;
		const style = geometry.getAttribute("instanceStyle") as InstancedBufferAttribute;
		writeEdgeSegmentInstance(geometry, 0, {
			edgeIndex: 0,
			x1: 0,
			y1: 0,
			z1: 0,
			x2: 10,
			y2: 0,
			z2: 0,
			color: "#226f54",
			width: 2,
			opacity: 0.5,
			style: "dashed",
			trimStart: 0,
			trimEnd: 0,
		});
		expect(kind.getX(0)).toBe(0);
		expect(a.getX(0)).toBe(0);
		expect(a.getY(0)).toBe(0);
		expect(a.getZ(0)).toBe(0);
		expect(b.getX(0)).toBe(10);
		expect(b.getY(0)).toBe(0);
		expect(b.getZ(0)).toBe(0);
		expect(width.getX(0)).toBe(2);
		expect(color.getW(0)).toBeCloseTo(0.5);
		expect(style.getX(0)).toBe(1); // dashed
	});

	test("writes marker kind and size", () => {
		const geometry = createEdgeGeometry(2);
		const kind = geometry.getAttribute("instanceKind") as InstancedBufferAttribute;
		const a = geometry.getAttribute("instanceEndA") as InstancedBufferAttribute;
		const b = geometry.getAttribute("instanceEndB") as InstancedBufferAttribute;
		const width = geometry.getAttribute("instanceWidth") as InstancedBufferAttribute;
		const style = geometry.getAttribute("instanceStyle") as InstancedBufferAttribute;
		const color = geometry.getAttribute("instanceColor") as InstancedBufferAttribute;
		writeEdgeMarkerInstance(geometry, 1, {
			edgeIndex: 0,
			end: "target",
			x: 10,
			y: 0,
			z: 0,
			dx: 10,
			dy: 0,
			dz: 0,
			color: "#226f54",
			size: 3,
			opacity: 0.9,
			trim: 0,
		});
		expect(kind.getX(1)).toBe(1);
		expect(width.getX(1)).toBe(3);
		expect(style.getX(1)).toBe(0);
		expect(a.getX(1)).toBe(10);
		expect(a.getY(1)).toBe(0);
		expect(a.getZ(1)).toBe(0);
		expect(b.getX(1)).toBe(20);
		expect(b.getY(1)).toBe(0);
		expect(b.getZ(1)).toBe(0);
		expect(color.getW(1)).toBeCloseTo(0.9);
	});

	test("does not disturb neighboring slots", () => {
		const geometry = createEdgeGeometry(2);
		const kind = geometry.getAttribute("instanceKind") as InstancedBufferAttribute;
		writeEdgeSegmentInstance(geometry, 0, {
			edgeIndex: 0,
			x1: 0,
			y1: 0,
			z1: 0,
			x2: 1,
			y2: 1,
			z2: 1,
			color: "#000000",
			width: 1,
			opacity: 1,
			style: "solid",
			trimStart: 0,
			trimEnd: 0,
		});
		writeEdgeMarkerInstance(geometry, 1, {
			edgeIndex: 0,
			end: "target",
			x: 1,
			y: 1,
			z: 1,
			dx: 1,
			dy: 0,
			dz: 0,
			color: "#ffffff",
			size: 2,
			opacity: 1,
			trim: 0,
		});
		expect(kind.getX(0)).toBe(0);
		expect(kind.getX(1)).toBe(1);
	});
});

describe("view-space edge ends", () => {
	/** Screen distance from the projected center, as a fraction of the node's projected radius. */
	function reach(camera: PerspectiveCamera, center: Vector3, viewPoint: Vector3, radius: number) {
		const viewCenter = center.clone().applyMatrix4(camera.matrixWorldInverse);
		const screen = (view: Vector3) => [view.x / -view.z, view.y / -view.z];
		const [cx, cy] = screen(viewCenter);
		const [px, py] = screen(viewPoint);
		return Math.hypot(px - cx, py - cy) / (radius / -viewCenter.z);
	}

	const random = (() => {
		let state = 7;
		return () => {
			state = (state * 1_664_525 + 1_013_904_223) >>> 0;
			return state / 2 ** 32;
		};
	})();

	test("segment ends and marker apexes land on the camera-facing outline from any view", () => {
		for (let index = 0; index < 300; index += 1) {
			const camera = new PerspectiveCamera(45, 1.5, 0.1, 10_000);
			camera.position.setFromSphericalCoords(600, Math.acos(random() * 2 - 1), random() * Math.PI * 2);
			camera.lookAt(0, 0, 0);
			camera.updateMatrixWorld();
			const source = new Vector3(random() * 200 - 100, random() * 200 - 100, random() * 200 - 100);
			const target = new Vector3(random() * 200 - 100, random() * 200 - 100, random() * 200 - 100);
			const viewSource = source.clone().applyMatrix4(camera.matrixWorldInverse);
			const viewTarget = target.clone().applyMatrix4(camera.matrixWorldInverse);
			const [a, b] = trimViewSegment(viewSource, viewTarget, 4, 9);
			if (!a || !b) continue; // fully hidden behind the two nodes
			expect(reach(camera, source, new Vector3(a.x, a.y, a.z), 4)).toBeCloseTo(1, 6);
			expect(reach(camera, target, new Vector3(b.x, b.y, b.z), 9)).toBeCloseTo(1, 6);
			const apex = markerApexInView(viewTarget, viewSource, 9);
			expect(reach(camera, target, new Vector3(apex.x, apex.y, apex.z), 9)).toBeCloseTo(1, 6);
		}
	});

	test("hides a segment whose trimmed ends would cross", () => {
		expect(trimViewSegment({ x: 0, y: 0, z: -100 }, { x: 5, y: 0, z: -120 }, 3, 3)).toEqual([null, null]);
	});

	test("writes trims into the instance buffer", () => {
		const geometry = createEdgeGeometry(2);
		const trim = geometry.getAttribute("instanceTrim") as InstancedBufferAttribute;
		writeEdgeSegmentInstance(geometry, 0, {
			edgeIndex: 0,
			x1: 0,
			y1: 0,
			z1: 0,
			x2: 10,
			y2: 0,
			z2: 0,
			color: "#226f54",
			width: 2,
			opacity: 1,
			style: "solid",
			trimStart: 2,
			trimEnd: 3,
		});
		writeEdgeMarkerInstance(geometry, 1, {
			edgeIndex: 0,
			end: "target",
			x: 10,
			y: 0,
			z: 0,
			dx: 1,
			dy: 0,
			dz: 0,
			color: "#226f54",
			size: 4,
			opacity: 1,
			trim: 3,
		});
		expect([trim.getX(0), trim.getY(0), trim.getX(1), trim.getY(1)]).toEqual([2, 3, 3, 0]);
		geometry.dispose();
	});
});
