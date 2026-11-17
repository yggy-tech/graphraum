import { Color, InstancedBufferAttribute, InstancedMesh } from "three";
import { describe, expect, test } from "vitest";

import {
	allocateNodeInstanceColors,
	createNodeGeometry,
	createNodeMaterial,
	setNodeShapeAt,
	setNodeStrokeAt,
} from "./node-rendering";

describe("node rendering buffers", () => {
	test("does not redeclare Three.js instanceColor from setColorAt", () => {
		const material = createNodeMaterial(false);
		// Three injects `attribute vec3 instanceColor` when InstancedMesh.instanceColor exists.
		// Redeclaring it in the ShaderMaterial source fails VALIDATE_STATUS with "redefinition".
		expect(material.vertexShader).not.toContain("attribute vec3 instanceColor;");
		expect(material.vertexShader).toContain("mix(instanceColor");
		material.dispose();
	});

	test("allocates InstancedMesh.instanceColor so Three enables USE_INSTANCING_COLOR", () => {
		const geometry = createNodeGeometry(2);
		const material = createNodeMaterial(false);
		const mesh = new InstancedMesh(geometry, material, 2);
		expect(mesh.instanceColor).toBeNull();
		allocateNodeInstanceColors(mesh, 2);
		expect(mesh.instanceColor).toBeInstanceOf(InstancedBufferAttribute);
		expect(mesh.instanceColor?.count).toBe(2);
		expect(mesh.instanceColor?.itemSize).toBe(3);
		geometry.dispose();
		material.dispose();
	});

	test("configures node depth for the active dimension", () => {
		const overlay = createNodeMaterial(false);
		const spatial = createNodeMaterial(true);

		expect(overlay.depthTest).toBe(false);
		expect(overlay.depthWrite).toBe(false);
		expect(spatial.depthTest).toBe(true);
		expect(spatial.depthWrite).toBe(true);
		overlay.dispose();
		spatial.dispose();
	});

	test("extends the fragment shader with SDFs for every catalog shape", () => {
		const material = createNodeMaterial(true);
		expect(material.fragmentShader).toContain("hexagonDistance");
		expect(material.fragmentShader).toContain("triangleDistance");
		expect(material.fragmentShader).toContain("pillDistance");
		expect(material.fragmentShader).toContain("roundedDistance");
		expect(material.fragmentShader).toContain("nodeStrokeWidth");
		expect(material.fragmentShader).toContain("nodeStrokeColor");
		material.dispose();
	});

	test("packs mixed shapes into one instanced geometry", () => {
		const geometry = createNodeGeometry(4);
		const shapes = geometry.getAttribute("instanceShape") as InstancedBufferAttribute;
		setNodeShapeAt(shapes, 0, undefined);
		setNodeShapeAt(shapes, 1, "circle");
		setNodeShapeAt(shapes, 2, "square");
		setNodeShapeAt(shapes, 3, "diamond");

		expect(shapes.count).toBe(4);
		expect([...shapes.array]).toEqual([0, 0, 1, 2]);
		geometry.dispose();
	});

	test("creates stroke width and color attributes at the requested capacity", () => {
		const geometry = createNodeGeometry(3);
		const strokeWidth = geometry.getAttribute("instanceStrokeWidth") as InstancedBufferAttribute;
		const strokeColor = geometry.getAttribute("instanceStrokeColor") as InstancedBufferAttribute;

		expect(strokeWidth.count).toBe(3);
		expect(strokeWidth.itemSize).toBe(1);
		expect(strokeColor.count).toBe(3);
		expect(strokeColor.itemSize).toBe(3);
		geometry.dispose();
	});

	test("packs stroke width and color into instanced attributes", () => {
		const geometry = createNodeGeometry(2);
		const strokeWidth = geometry.getAttribute("instanceStrokeWidth") as InstancedBufferAttribute;
		const strokeColor = geometry.getAttribute("instanceStrokeColor") as InstancedBufferAttribute;

		setNodeStrokeAt(strokeWidth, strokeColor, 0, { strokeColor: "#fcfffc", strokeWidthUv: 0.1 });
		setNodeStrokeAt(strokeWidth, strokeColor, 1, { strokeColor: "#226f54", strokeWidthUv: 0 });

		const expectedFirst = new Color("#fcfffc");
		const expectedSecond = new Color("#226f54");
		expect(strokeWidth.getX(0)).toBeCloseTo(0.1);
		expect(strokeWidth.getX(1)).toBe(0);
		expect(strokeColor.getX(0)).toBeCloseTo(expectedFirst.r);
		expect(strokeColor.getY(0)).toBeCloseTo(expectedFirst.g);
		expect(strokeColor.getZ(0)).toBeCloseTo(expectedFirst.b);
		expect(strokeColor.getX(1)).toBeCloseTo(expectedSecond.r);
		expect(strokeColor.getY(1)).toBeCloseTo(expectedSecond.g);
		expect(strokeColor.getZ(1)).toBeCloseTo(expectedSecond.b);
		geometry.dispose();
	});

	test("does not disturb neighboring stroke slots", () => {
		const geometry = createNodeGeometry(2);
		const strokeWidth = geometry.getAttribute("instanceStrokeWidth") as InstancedBufferAttribute;
		const strokeColor = geometry.getAttribute("instanceStrokeColor") as InstancedBufferAttribute;

		setNodeStrokeAt(strokeWidth, strokeColor, 0, { strokeColor: "#000000", strokeWidthUv: 0.2 });

		expect(strokeWidth.getX(1)).toBe(0);
		expect(strokeColor.getX(1)).toBe(0);
		expect(strokeColor.getY(1)).toBe(0);
		expect(strokeColor.getZ(1)).toBe(0);
		geometry.dispose();
	});
});
