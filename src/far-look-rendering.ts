import {
	AddEquation,
	AdditiveBlending,
	Color,
	CustomBlending,
	DstColorFactor,
	InstancedMesh,
	type IUniform,
	OneFactor,
	PlaneGeometry,
	type Scene,
	ShaderMaterial,
	ZeroFactor,
} from "three";

import {
	FAR_LOOK_LIGHT_EDGE_COLOR,
	FAR_LOOK_LIGHT_EDGE_WIDTH,
	FAR_LOOK_LIGHT_MUTE,
	type ResolvedFarLookOptions,
	referenceFarLookAmount,
} from "./far-look";
import { GLOW_RENDER_ORDER } from "./node-glow-rendering";
import { OUTPUT_COLOR_SPACE_FRAGMENT } from "./shader-output";

/** Draws under the opt-in hub halos (`GLOW_RENDER_ORDER`), so a hub glow sits on the ambient one. */
export const FAR_LOOK_RENDER_ORDER = GLOW_RENDER_ORDER - 1;

/** Halo radius as a multiple of the node's half extent. */
const HALO_RADIUS_SCALE = 3;

/**
 * Uniforms shared by the node, edge and halo materials, so one write per frame reaches them all.
 * `graphraumWorldPerPixel` is 0 when the look is off, which turns every term below into a no-op.
 */
export interface FarLookUniforms {
	[uniform: string]: IUniform;
	graphraumFarEdge: IUniform<number>;
	graphraumFarEdgeColor: IUniform<Color>;
	graphraumFarEdgeWidth: IUniform<number>;
	graphraumFarFar: IUniform<number>;
	graphraumFarMute: IUniform<number>;
	graphraumFarNear: IUniform<number>;
	graphraumFarStrength: IUniform<number>;
	graphraumWorldPerPixel: IUniform<number>;
}

export function createFarLookUniforms(): FarLookUniforms {
	return {
		graphraumFarEdge: { value: 0 },
		graphraumFarEdgeColor: { value: new Color(FAR_LOOK_LIGHT_EDGE_COLOR) },
		graphraumFarEdgeWidth: { value: 1 },
		graphraumFarFar: { value: 1 },
		graphraumFarMute: { value: 0 },
		graphraumFarNear: { value: 2 },
		graphraumFarStrength: { value: 0 },
		graphraumWorldPerPixel: { value: 0 },
	};
}

/** GLSL for the node and halo vertex shaders: the curve of `farLookAmount`, per node. */
export const FAR_LOOK_NODE_GLSL = `
uniform float graphraumWorldPerPixel;
uniform float graphraumFarNear;
uniform float graphraumFarFar;

// 0 up close, 1 far out, from the node's on-screen width in CSS pixels (see farLookAmount in far-look.ts).
float graphraumFarAmount(float nodeWorldWidth) {
	if (graphraumWorldPerPixel <= 0.0) return 0.0;
	float pixels = nodeWorldWidth / graphraumWorldPerPixel;
	if (pixels >= graphraumFarNear) return 0.0;
	return 1.0 - smoothstep(graphraumFarFar, graphraumFarNear, pixels);
}
`;

const haloVertexShader = `
${FAR_LOOK_NODE_GLSL}
varying vec3 haloColor;
varying vec2 haloPoint;
varying float haloAmount;

void main() {
	float extent = max(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
	haloAmount = graphraumFarAmount(2.0 * extent);
	haloColor = instanceColor;
	haloPoint = position.xy;
	if (haloAmount <= 0.0) {
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // clipped away: no fragments up close
		return;
	}
	vec4 center = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
	center.xy += position.xy * extent * ${HALO_RADIUS_SCALE.toFixed(1)};
	gl_Position = projectionMatrix * center;
}
`;

// Dark: the halo adds light. Light ("ink on paper"): the halo multiplies the paper, so it only darkens.
const haloFragmentShader = `
uniform float graphraumFarStrength;
varying vec3 haloColor;
varying vec2 haloPoint;
varying float haloAmount;

void main() {
	float distanceFromCenter = length(haloPoint);
	if (distanceFromCenter >= 1.0) discard;
	float falloff = 1.0 - distanceFromCenter;
	float strength = falloff * falloff * haloAmount * graphraumFarStrength;
#ifdef GRAPHRAUM_FAR_MULTIPLY
	gl_FragColor = vec4(mix(vec3(1.0), haloColor, strength), 1.0);
#else
	gl_FragColor = vec4(haloColor, strength);
#endif
	${OUTPUT_COLOR_SPACE_FRAGMENT}
}
`;

export function createFarLookHaloMaterial(uniforms: FarLookUniforms, ink: boolean): ShaderMaterial {
	const material = new ShaderMaterial({
		depthTest: false,
		depthWrite: false,
		fragmentShader: haloFragmentShader,
		transparent: true,
		uniforms,
		vertexShader: haloVertexShader,
	});
	applyHaloBlending(material, ink);
	return material;
}

function applyHaloBlending(material: ShaderMaterial, ink: boolean) {
	if (ink) {
		// result = paper * halo; the alpha channel stays as it was.
		material.blending = CustomBlending;
		material.blendEquation = AddEquation;
		material.blendSrc = DstColorFactor;
		material.blendDst = ZeroFactor;
		material.blendSrcAlpha = ZeroFactor;
		material.blendDstAlpha = OneFactor;
		material.defines = { GRAPHRAUM_FAR_MULTIPLY: "" };
	} else {
		material.blending = AdditiveBlending;
		material.defines = {};
	}
	material.needsUpdate = true;
}

/**
 * The far look: one extra instanced draw that shares the node mesh's matrix and colour buffers, so
 * every node gets a soft halo with no per-node CPU work and no copy. The node and edge shaders read
 * the same uniforms for the muted colours and thin grey edges of the light look.
 */
export class FarLookLayer {
	readonly uniforms = createFarLookUniforms();
	private ink = false;
	private mesh: InstancedMesh<PlaneGeometry, ShaderMaterial> | null = null;
	private readonly scene: Scene;

	constructor(scene: Scene) {
		this.scene = scene;
	}

	/** Shares `nodeMesh`'s buffers; call after the node mesh exists and again for a new one. */
	attach(nodeMesh: InstancedMesh) {
		this.release();
		const mesh = new InstancedMesh(new PlaneGeometry(2, 2), createFarLookHaloMaterial(this.uniforms, this.ink), 1);
		mesh.instanceMatrix = nodeMesh.instanceMatrix;
		if (nodeMesh.instanceColor) mesh.instanceColor = nodeMesh.instanceColor;
		mesh.count = nodeMesh.count;
		mesh.frustumCulled = false;
		mesh.name = "graphraum-far-look";
		mesh.renderOrder = FAR_LOOK_RENDER_ORDER;
		this.mesh = mesh;
	}

	/** Follows the node mesh's drawn count. */
	setCount(count: number) {
		if (this.mesh) this.mesh.count = count;
	}

	/**
	 * Writes this frame's look from the shared scale (`unitsPerPixel`, 0 in 3D). `ink` is the light
	 * look: multiply halos, muted nodes, thin grey edges. `reachable` is false while no node can be
	 * small enough, which keeps the halo draw out of the frame.
	 */
	update(unitsPerPixel: number, options: ResolvedFarLookOptions, ink: boolean, reachable = true) {
		const active = options.enabled && unitsPerPixel > 0;
		const { uniforms } = this;
		uniforms.graphraumWorldPerPixel.value = active ? unitsPerPixel : 0;
		uniforms.graphraumFarNear.value = options.nearPixels;
		uniforms.graphraumFarFar.value = options.farPixels;
		uniforms.graphraumFarStrength.value = options.strength;
		uniforms.graphraumFarMute.value = ink ? FAR_LOOK_LIGHT_MUTE : 0;
		const edge = ink ? referenceFarLookAmount(unitsPerPixel, options) : 0;
		uniforms.graphraumFarEdge.value = edge;
		uniforms.graphraumFarEdgeWidth.value = 1 + (FAR_LOOK_LIGHT_EDGE_WIDTH - 1) * edge;
		if (ink !== this.ink) {
			this.ink = ink;
			if (this.mesh) applyHaloBlending(this.mesh.material, ink);
		}
		// In the scene only while it draws, so a graph that never zooms out keeps its two draw calls.
		const mesh = this.mesh;
		if (!mesh) return;
		const draws = active && reachable && options.strength > 0 && mesh.count > 0;
		if (draws && mesh.parent === null) this.scene.add(mesh);
		else if (!draws && mesh.parent !== null) this.scene.remove(mesh);
	}

	/** Releases the halo mesh; the node mesh keeps the shared buffers. */
	dispose() {
		this.release();
	}

	private release() {
		if (!this.mesh) return;
		this.scene.remove(this.mesh);
		this.mesh.geometry.dispose();
		this.mesh.material.dispose();
		// No `mesh.dispose()`: it would free the node mesh's shared instance buffers on the GPU.
		this.mesh = null;
	}
}
