import { Color, InstancedBufferAttribute, type InstancedMesh, PlaneGeometry, ShaderMaterial, Vector3 } from "three";

import { encodeNodeShape } from "./node-shapes";
import { OUTPUT_COLOR_SPACE_FRAGMENT } from "./shader-output";
import type { GraphraumColor, GraphraumNodeShape, GraphraumShading } from "./types";

// Do not declare `attribute vec3 instanceColor` here. Three.js injects it when
// InstancedMesh.instanceColor is set (USE_INSTANCING_COLOR). A second declaration
// fails shader validate with "instanceColor : redefinition".
const vertexShader = `
attribute float instanceShape;
attribute float instanceStrokeWidth;
attribute vec3 instanceStrokeColor;
varying vec3 nodeColor;
varying vec2 nodePoint;
varying float nodeShape;
varying float nodeStrokeWidth;
varying vec3 nodeStrokeColor;
#ifdef GRAPHRAUM_SPHERE_IMPOSTOR
varying vec3 nodeViewCenter;
varying float nodeRadius;
#endif

void main() {
	nodeColor = instanceColor;
	nodePoint = position.xy;
	nodeShape = instanceShape;
	nodeStrokeWidth = instanceStrokeWidth;
	nodeStrokeColor = instanceStrokeColor;

	vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
	float scaleX = length(instanceMatrix[0].xyz);
	float scaleY = length(instanceMatrix[1].xyz);
#ifdef GRAPHRAUM_SPHERE_IMPOSTOR
	nodeViewCenter = center.xyz;
	nodeRadius = max(scaleX, scaleY);
#endif
	center.xy += position.xy * vec2(scaleX, scaleY);
	gl_Position = projectionMatrix * center;
}
`;

const fragmentShader = `
#ifdef GRAPHRAUM_SPHERE_IMPOSTOR
uniform mat4 projectionMatrix;
varying vec3 nodeViewCenter;
varying float nodeRadius;
#endif
#ifdef GRAPHRAUM_SHADING
// 1 = lit, 2 = toon. Light colours are linear and already scaled by their intensity.
uniform vec3 graphraumSunDirection;
uniform vec3 graphraumSunColor;
uniform vec3 graphraumSkyColor;
uniform vec3 graphraumGroundColor;
#endif
varying vec3 nodeColor;
varying vec2 nodePoint;
varying float nodeShape;
varying float nodeStrokeWidth;
varying vec3 nodeStrokeColor;

// Apothem of a regular hexagon whose pointy left/right vertices reach x = ±1 (matches node-shapes.ts).
const float HEXAGON_APOTHEM = 0.8660254037844386;
// Y of the upward triangle's flat base, apex at (0, 1) (matches node-shapes.ts).
const float TRIANGLE_BASE_Y = -0.7320508075688772;
// Half-height of the horizontal pill's rounded caps, in unit space (matches node-shapes.ts).
const float PILL_CAP_RADIUS = 0.5;
// Half-length of the pill's straight segment, in unit space (matches node-shapes.ts).
const float PILL_HALF_LENGTH = 0.5;
// Fraction of the rounded rectangle's half-extent used as the corner radius (matches node-shapes.ts).
const float ROUNDED_CORNER_RADIUS = 0.25;

float hexagonDistance(vec2 p) {
	vec2 a = abs(p);
	return HEXAGON_APOTHEM - max(a.y, a.x * HEXAGON_APOTHEM + a.y * 0.5);
}

// Signed distance to an upward-pointing equilateral triangle, positive inside.
float triangleDistance(vec2 p) {
	vec2 apex = vec2(0.0, 1.0);
	vec2 right = vec2(1.0, TRIANGLE_BASE_Y);
	vec2 left = vec2(-1.0, TRIANGLE_BASE_Y);
	vec2 e0 = right - apex;
	vec2 e1 = left - right;
	vec2 e2 = apex - left;
	vec2 v0 = p - apex;
	vec2 v1 = p - right;
	vec2 v2 = p - left;
	vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
	vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
	vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
	float s = sign(e0.x * e2.y - e0.y * e2.x);
	vec2 d0 = vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x));
	vec2 d1 = vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x));
	vec2 d2 = vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x));
	vec2 d = min(min(d0, d1), d2);
	return sqrt(d.x) * sign(d.y);
}

float pillDistance(vec2 p) {
	float clampedX = clamp(p.x, -PILL_HALF_LENGTH, PILL_HALF_LENGTH);
	return PILL_CAP_RADIUS - length(vec2(p.x - clampedX, p.y));
}

#ifdef GRAPHRAUM_SHADING
// Circles are spheres; other shapes get a bevel that rises over the outer third of their inset.
vec3 surfaceNormal(float distanceToEdge, bool circle) {
	if (circle) return vec3(nodePoint, sqrt(max(0.0, 1.0 - dot(nodePoint, nodePoint))));
	float rise = smoothstep(0.0, 0.35, distanceToEdge);
	return normalize(vec3(nodePoint * (1.0 - rise) * 0.8, 0.35 + rise));
}

vec3 shade(vec3 base, vec3 normal) {
	// The billboard faces the camera, so the normal is in view space; viewMatrix brings the sun there.
	vec3 toSun = normalize((viewMatrix * vec4(graphraumSunDirection, 0.0)).xyz);
	float up = (vec4(normal, 0.0) * viewMatrix).y;
	vec3 ambient = mix(graphraumGroundColor, graphraumSkyColor, up * 0.5 + 0.5);
	float diffuse = max(dot(normal, toSun), 0.0);
	float facing = max(dot(normal, normalize(toSun + vec3(0.0, 0.0, 1.0))), 0.0);
#if GRAPHRAUM_SHADING == 2
	float band = diffuse < 0.15 ? 0.0 : (diffuse < 0.6 ? 0.55 : 1.0);
	return base * (ambient + graphraumSunColor * band) + graphraumSunColor * step(0.96, facing) * 0.45;
#else
	return base * (ambient + graphraumSunColor * diffuse) + graphraumSunColor * pow(facing, 32.0) * 0.35;
#endif
}
#endif

float roundedDistance(vec2 p) {
	vec2 outsideOffset = abs(p) - vec2(1.0 - ROUNDED_CORNER_RADIUS);
	vec2 outside = max(outsideOffset, 0.0);
	float outsideDistance = length(outside) + min(max(outsideOffset.x, outsideOffset.y), 0.0) - ROUNDED_CORNER_RADIUS;
	return -outsideDistance;
}

void main() {
	float distanceToEdge;
	if (nodeShape < 0.5) {
		distanceToEdge = 1.0 - length(nodePoint);
	} else if (nodeShape < 1.5) {
		distanceToEdge = 1.0 - max(abs(nodePoint.x), abs(nodePoint.y));
	} else if (nodeShape < 2.5) {
		distanceToEdge = 1.0 - abs(nodePoint.x) - abs(nodePoint.y);
	} else if (nodeShape < 3.5) {
		distanceToEdge = hexagonDistance(nodePoint);
	} else if (nodeShape < 4.5) {
		distanceToEdge = triangleDistance(nodePoint);
	} else if (nodeShape < 5.5) {
		distanceToEdge = pillDistance(nodePoint);
	} else {
		distanceToEdge = roundedDistance(nodePoint);
	}

	float outerAlpha = smoothstep(0.0, fwidth(distanceToEdge), distanceToEdge);
	if (outerAlpha <= 0.0) discard;

#ifdef GRAPHRAUM_SPHERE_IMPOSTOR
	// Circles bulge towards the camera like a sphere; other shapes keep their billboard plane.
	// Clip depth depends only on view z for perspective and orthographic projections.
	float bulge = nodeShape < 0.5 ? sqrt(max(0.0, 1.0 - dot(nodePoint, nodePoint))) : 0.0;
	vec4 surface = projectionMatrix * vec4(0.0, 0.0, nodeViewCenter.z + bulge * nodeRadius, 1.0);
	gl_FragDepth = clamp(surface.z / surface.w * 0.5 + 0.5, 0.0, 1.0);
#endif

	vec3 fillColor = nodeColor;
#ifdef GRAPHRAUM_SHADING
	// Only the fill takes light; the stroke stays unlit and reads as a rim.
	fillColor = shade(nodeColor, surfaceNormal(distanceToEdge, nodeShape < 0.5));
#endif
	if (nodeStrokeWidth > 0.0) {
		// Stroke band occupies [outer edge, outer edge - nodeStrokeWidth]; below that, the fill takes over.
		float innerEdge = distanceToEdge - nodeStrokeWidth;
		float strokeToFill = smoothstep(0.0, fwidth(innerEdge), innerEdge);
		fillColor = mix(nodeStrokeColor, fillColor, strokeToFill);
	}
	gl_FragColor = vec4(fillColor, outerAlpha);
	${OUTPUT_COLOR_SPACE_FRAGMENT}
}
`;

export function createNodeGeometry(capacity: number) {
	const geometry = new PlaneGeometry(2, 2);
	geometry.setAttribute("instanceShape", new InstancedBufferAttribute(new Float32Array(capacity), 1));
	geometry.setAttribute("instanceStrokeWidth", new InstancedBufferAttribute(new Float32Array(capacity), 1));
	geometry.setAttribute("instanceStrokeColor", new InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
	return geometry;
}

/** Allocate InstancedMesh.instanceColor before first compile so Three injects the attribute. */
export function allocateNodeInstanceColors(mesh: InstancedMesh, capacity: number) {
	mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
}

/** After glow halos and edges, so node billboards always cover edges. */
export const NODE_RENDER_ORDER = 1;

export function createNodeMaterial(depthTest: boolean) {
	return new ShaderMaterial({
		depthTest,
		depthWrite: depthTest,
		fragmentShader,
		transparent: true,
		uniforms: {
			graphraumSunDirection: { value: new Vector3(0, 1, 0) },
			graphraumSunColor: { value: new Color(0, 0, 0) },
			graphraumSkyColor: { value: new Color(1, 1, 1) },
			graphraumGroundColor: { value: new Color(1, 1, 1) },
		},
		vertexShader,
	});
}

/** Shader define that turns circle billboards into depth-writing sphere impostors. */
export const SPHERE_IMPOSTOR_DEFINE = "GRAPHRAUM_SPHERE_IMPOSTOR";

/** Shader define that lights the fill: `1` lit, `2` toon; absent for flat. */
export const SHADING_DEFINE = "GRAPHRAUM_SHADING";

const SHADING_DEFINE_VALUES: Record<GraphraumShading, string | null> = { flat: null, lit: "1", toon: "2" };

export interface NodeMaterialSetup {
	depth: boolean;
	shading: GraphraumShading;
	sphereImpostors: boolean;
}

/** Applies depth, the sphere impostor and the shading defines; recompiles only when a define changes. */
export function configureNodeMaterial(
	material: ShaderMaterial,
	{ depth, shading, sphereImpostors }: NodeMaterialSetup,
) {
	material.depthTest = depth;
	material.depthWrite = depth;
	const defines: Record<string, unknown> = { ...(material.defines ?? {}) };
	if (sphereImpostors) defines[SPHERE_IMPOSTOR_DEFINE] = "";
	else delete defines[SPHERE_IMPOSTOR_DEFINE];
	const shadingValue = SHADING_DEFINE_VALUES[shading];
	if (shadingValue === null) delete defines[SHADING_DEFINE];
	else defines[SHADING_DEFINE] = shadingValue;
	const previous = material.defines ?? {};
	const changed =
		Object.keys(defines).length !== Object.keys(previous).length ||
		Object.entries(defines).some(([key, value]) => previous[key] !== value);
	if (!changed) return;
	material.defines = defines;
	material.needsUpdate = true;
}

export interface NodeLighting {
	sunDirection: readonly [number, number, number];
	sun: Color;
	sky: Color;
	ground: Color;
}

/** Writes the light uniforms; no recompile. */
export function setNodeLighting(material: ShaderMaterial, lighting: NodeLighting) {
	const uniforms = material.uniforms;
	(uniforms.graphraumSunDirection?.value as Vector3 | undefined)?.set(...lighting.sunDirection);
	(uniforms.graphraumSunColor?.value as Color | undefined)?.copy(lighting.sun);
	(uniforms.graphraumSkyColor?.value as Color | undefined)?.copy(lighting.sky);
	(uniforms.graphraumGroundColor?.value as Color | undefined)?.copy(lighting.ground);
}

export function setNodeShapeAt(
	attribute: InstancedBufferAttribute,
	index: number,
	shape: GraphraumNodeShape | undefined,
) {
	attribute.setX(index, encodeNodeShape(shape));
}

export interface NodeStrokeInput {
	strokeColor: GraphraumColor;
	/**
	 * Stroke ring width as a fraction of the node's unit half-extent (the
	 * [-1, 1] local shape space rendered before the instance matrix scales it
	 * to `width`/`height`). Callers holding a stroke width in world units
	 * divide it by `max(width, height)` to get this fraction, so the ring
	 * occupies a consistent proportion of the shape's outline regardless of
	 * the node's rendered size.
	 */
	strokeWidthUv: number;
}

export function setNodeStrokeAt(
	strokeWidthAttribute: InstancedBufferAttribute,
	strokeColorAttribute: InstancedBufferAttribute,
	index: number,
	{ strokeColor, strokeWidthUv }: NodeStrokeInput,
) {
	strokeWidthAttribute.setX(index, strokeWidthUv);
	const rgb = new Color(strokeColor);
	strokeColorAttribute.setXYZ(index, rgb.r, rgb.g, rgb.b);
}
