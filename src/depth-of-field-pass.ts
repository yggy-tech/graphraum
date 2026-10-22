import {
	BufferGeometry,
	DepthTexture,
	Float32BufferAttribute,
	GLSL3,
	type InstancedMesh,
	Mesh,
	NoBlending,
	OrthographicCamera,
	type PerspectiveCamera,
	Scene,
	ShaderMaterial,
	SRGBColorSpace,
	UnsignedByteType,
	Vector2,
	type WebGLRenderer,
	WebGLRenderTarget,
} from "three";

import { OUTPUT_COLOR_SPACE_FRAGMENT } from "./shader-output";

/** Layer the edge mesh joins so the edge depth pass can draw it alone. Picking raycasts layer 0. */
const EDGE_DEPTH_LAYER = 1;
/** Disk taps around the centre of each half-resolution blur texel. */
const BLUR_TAPS = 48;

export interface DepthOfFieldFrame {
	/** Device pixels of blur per unit of `|d - f| / d`. */
	aperturePixels: number;
	/** Focal plane distance from the camera in world units. */
	focusDistance: number;
	/** Largest blur radius in device pixels; also the gather radius. */
	maxBlurPixels: number;
	/** Blur radii below this many device pixels render sharp. */
	minBlurPixels: number;
}

const vertexShader = `
varying vec2 vUv;

void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Nodes write depth and edges do not (nodes always cover edges), so edges get their own depth
// texture. A pixel shows a node where the node depth is set, otherwise the nearest edge, otherwise
// the background at the far plane. Every pass addresses pixels with integer texel fetches, so a
// tap's colour and blur radius always come from the same pixel. `blurRadius` mirrors
// `circleOfConfusion` in depth-of-field.ts.
const blurRadiusChunk = `
#include <packing>
uniform sampler2D nodeDepth;
uniform sampler2D edgeDepth;
uniform ivec2 depthSize;
uniform float cameraNear;
uniform float cameraFar;
uniform float focusDistance;
uniform float aperture;
uniform float minBlur;
uniform float maxBlur;

float surfaceDistance(ivec2 pixel) {
	pixel = clamp(pixel, ivec2(0), depthSize - 1);
	float depth = texelFetch(nodeDepth, pixel, 0).x;
	if (depth >= 1.0) depth = texelFetch(edgeDepth, pixel, 0).x;
	return -perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
}

float radiusAt(float surface) {
	float radius = aperture * abs(surface - focusDistance) / max(surface, 1e-6);
	return radius < minBlur ? 0.0 : min(radius, maxBlur);
}

float blurRadius(ivec2 pixel) {
	return radiusAt(surfaceDistance(pixel));
}
`;

// One disk gather from the full-resolution scene into a half-resolution target: taps on a golden-angle
// spiral that fills a circle of the largest blur radius. Half-resolution texel (i, j) stands for
// full-resolution pixel (2i, 2j). A tap counts only when its own blur radius reaches the centre, so
// sharp nodes do not bleed into the blurred surroundings. A separable blur would cost fewer taps, but
// a tap's weight depends on its own radius, which a second pass cannot recover.
//
// The second output is the near field: blurred surfaces in front of the focal plane and of this pixel
// spread over it, so a blurred foreground node softly covers sharp nodes behind it. Each tap adds its
// colour spread over its own blur disk (area ratio maxBlur^2 / radius^2), premultiplied by coverage.
const blurFragmentShader = `
${blurRadiusChunk}
uniform sampler2D colorTexture;
layout(location = 0) out highp vec4 blurColor;
layout(location = 1) out highp vec4 nearColor;

const float GOLDEN_ANGLE = 2.39996323;

void main() {
	ivec2 base = ivec2(gl_FragCoord.xy) * 2;
	float centreSurface = surfaceDistance(base);
	vec4 sum = texelFetch(colorTexture, base, 0);
	float total = 1.0;
	vec4 near = vec4(0.0);
	// Interleaved gradient noise turns the spiral's fixed tap pattern into fine noise that the
	// composite's bilinear upsample smooths, instead of hatching along blurred edges.
	float rotation = 6.28318531 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
	for (int index = 0; index < ${BLUR_TAPS}; index++) {
		float distanceFromCentre = sqrt((float(index) + 0.5) / ${BLUR_TAPS}.0) * maxBlur;
		float angle = float(index) * GOLDEN_ANGLE + rotation;
		ivec2 pixel = clamp(base + ivec2(floor(vec2(cos(angle), sin(angle)) * distanceFromCentre + 0.5)), ivec2(0), depthSize - 1);
		float surface = surfaceDistance(pixel);
		float radius = radiusAt(surface);
		float weight = clamp(radius - distanceFromCentre + 1.0, 0.0, 1.0);
		vec4 color = texelFetch(colorTexture, pixel, 0);
		sum += color * weight;
		total += weight;
		if (surface < focusDistance && surface < centreSurface) {
			near += color * weight * (maxBlur * maxBlur / max(radius * radius, 1.0));
		}
	}
	blurColor = sum / total;
	near /= ${BLUR_TAPS}.0;
	nearColor = near.a > 1.0 ? near / near.a : near;
}
`;

const compositeFragmentShader = `
${blurRadiusChunk}
uniform sampler2D sharpTexture;
uniform sampler2D blurTexture;
uniform sampler2D nearTexture;
varying vec2 vUv;

void main() {
	ivec2 pixel = ivec2(gl_FragCoord.xy);
	vec4 near = texture2D(nearTexture, vUv);
	vec4 sharp = texelFetch(sharpTexture, pixel, 0);
	sharp = near + sharp * (1.0 - near.a);
	vec4 blurred = texture2D(blurTexture, vUv);
	gl_FragColor = mix(sharp, blurred, smoothstep(0.5, 2.0, blurRadius(pixel)));
	${OUTPUT_COLOR_SPACE_FRAGMENT}
}
`;

function blurUniforms() {
	return {
		cameraFar: { value: 1 },
		aperture: { value: 0 },
		cameraNear: { value: 0.1 },
		depthSize: { value: new Vector2() },
		edgeDepth: { value: null },
		focusDistance: { value: 1 },
		maxBlur: { value: 0 },
		minBlur: { value: 0 },
		nodeDepth: { value: null },
	};
}

function fullscreenMaterial(
	fragmentShader: string,
	uniforms: Record<string, { value: unknown }>,
	glslVersion: typeof GLSL3 | null = null,
) {
	return new ShaderMaterial({
		blending: NoBlending,
		depthTest: false,
		depthWrite: false,
		fragmentShader,
		glslVersion,
		uniforms,
		vertexShader,
	});
}

/** One triangle that covers the viewport. */
function fullscreenTriangle() {
	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
	geometry.setAttribute("uv", new Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
	return geometry;
}

/**
 * Renders the scene into a target, the edges into a depth-only target, blurs at half resolution and
 * composites onto the canvas: three extra draw calls per frame while it runs.
 * Created only while depth of field has something to blur; `dispose` releases every GPU resource.
 */
export class DepthOfFieldPass {
	private readonly sceneTarget: WebGLRenderTarget;
	private readonly edgeDepthTarget: WebGLRenderTarget;
	private readonly blurTarget: WebGLRenderTarget;
	private readonly blurMaterial = fullscreenMaterial(
		blurFragmentShader,
		{ ...blurUniforms(), colorTexture: { value: null } },
		GLSL3,
	);
	private readonly compositeMaterial = fullscreenMaterial(compositeFragmentShader, {
		...blurUniforms(),
		blurTexture: { value: null },
		nearTexture: { value: null },
		sharpTexture: { value: null },
	});
	private readonly quad = new Mesh(fullscreenTriangle(), this.blurMaterial);
	private readonly quadScene = new Scene().add(this.quad);
	private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
	private readonly size = new Vector2();

	/** Depth of field needs WebGL 2 for depth textures and sRGB render targets. */
	static isSupported(renderer: WebGLRenderer): boolean {
		return typeof WebGL2RenderingContext !== "undefined" && renderer.getContext() instanceof WebGL2RenderingContext;
	}

	constructor(antialias: boolean) {
		// sRGB storage keeps 8-bit targets free of banding in dark backgrounds without float extensions.
		const color = { colorSpace: SRGBColorSpace, type: UnsignedByteType } as const;
		this.sceneTarget = new WebGLRenderTarget(1, 1, {
			...color,
			depthTexture: new DepthTexture(1, 1),
			samples: antialias ? 4 : 0,
		});
		this.edgeDepthTarget = new WebGLRenderTarget(1, 1, { depthTexture: new DepthTexture(1, 1) });
		// Attachment 0 holds the blur, attachment 1 the near field.
		this.blurTarget = new WebGLRenderTarget(1, 1, { ...color, count: 2 });
		this.quad.frustumCulled = false;
	}

	render(
		renderer: WebGLRenderer,
		scene: Scene,
		camera: PerspectiveCamera,
		edgeMesh: InstancedMesh | null,
		frame: DepthOfFieldFrame,
	) {
		const { x: width, y: height } = renderer.getDrawingBufferSize(this.size);
		this.setSize(width, height);
		const previousTarget = renderer.getRenderTarget();

		renderer.setRenderTarget(this.sceneTarget);
		renderer.render(scene, camera);
		this.renderEdgeDepth(renderer, scene, camera, edgeMesh);

		const shared = {
			aperture: frame.aperturePixels,
			cameraFar: camera.far,
			cameraNear: camera.near,
			depthSize: this.size,
			edgeDepth: this.edgeDepthTarget.depthTexture,
			focusDistance: frame.focusDistance,
			maxBlur: frame.maxBlurPixels,
			minBlur: frame.minBlurPixels,
			nodeDepth: this.sceneTarget.depthTexture,
		};
		this.quad.material = this.blurMaterial;
		this.setUniforms(this.blurMaterial, { ...shared, colorTexture: this.sceneTarget.texture });
		this.drawQuad(renderer, this.blurTarget);

		this.quad.material = this.compositeMaterial;
		this.setUniforms(this.compositeMaterial, {
			...shared,
			blurTexture: this.blurTarget.textures[0],
			nearTexture: this.blurTarget.textures[1],
			sharpTexture: this.sceneTarget.texture,
		});
		this.drawQuad(renderer, previousTarget);
	}

	dispose() {
		this.sceneTarget.depthTexture?.dispose();
		this.sceneTarget.dispose();
		this.edgeDepthTarget.depthTexture?.dispose();
		this.edgeDepthTarget.dispose();
		this.blurTarget.dispose();
		this.blurMaterial.dispose();
		this.compositeMaterial.dispose();
		this.quad.geometry.dispose();
	}

	/** Draws the edges alone with depth writes on and colour writes off, then restores their material. */
	private renderEdgeDepth(
		renderer: WebGLRenderer,
		scene: Scene,
		camera: PerspectiveCamera,
		edgeMesh: InstancedMesh | null,
	) {
		renderer.setRenderTarget(this.edgeDepthTarget);
		if (!edgeMesh || edgeMesh.count === 0 || Array.isArray(edgeMesh.material)) {
			renderer.clear();
			return;
		}
		const material = edgeMesh.material;
		const { colorWrite, depthTest, depthWrite } = material;
		const layerMask = camera.layers.mask;
		const background = scene.background;
		edgeMesh.layers.enable(EDGE_DEPTH_LAYER);
		material.colorWrite = false;
		material.depthTest = true;
		material.depthWrite = true;
		camera.layers.set(EDGE_DEPTH_LAYER);
		scene.background = null;
		try {
			renderer.render(scene, camera);
		} finally {
			material.colorWrite = colorWrite;
			material.depthTest = depthTest;
			material.depthWrite = depthWrite;
			camera.layers.mask = layerMask;
			scene.background = background;
		}
	}

	private drawQuad(renderer: WebGLRenderer, target: WebGLRenderTarget | null) {
		renderer.setRenderTarget(target);
		renderer.render(this.quadScene, this.quadCamera);
	}

	private setUniforms(material: ShaderMaterial, values: Record<string, unknown>) {
		for (const [name, value] of Object.entries(values)) {
			const uniform = material.uniforms[name];
			if (uniform) uniform.value = value;
		}
	}

	private setSize(width: number, height: number) {
		if (this.sceneTarget.width === width && this.sceneTarget.height === height) return;
		this.sceneTarget.setSize(width, height);
		this.edgeDepthTarget.setSize(width, height);
		const halfWidth = Math.max(1, Math.ceil(width / 2));
		const halfHeight = Math.max(1, Math.ceil(height / 2));
		this.blurTarget.setSize(halfWidth, halfHeight);
	}
}
