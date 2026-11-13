import {
	BufferGeometry,
	type Camera,
	Color,
	Float32BufferAttribute,
	Mesh,
	NoBlending,
	OrthographicCamera,
	Scene,
	ShaderMaterial,
	SRGBColorSpace,
	UnsignedByteType,
	Vector2,
	Vector3,
	type WebGLRenderer,
	WebGLRenderTarget,
} from "three";

import { RADIAL_MIN_BLUR_PIXELS, type RadialFocusFrame } from "./radial-focus";
import { OUTPUT_COLOR_SPACE_FRAGMENT } from "./shader-output";

/** Disk taps around the centre of each half-resolution blur texel. */
const BLUR_TAPS = 40;

const vertexShader = `
varying vec2 vUv;

void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Blur radius in device pixels from the distance to the focus: none inside the inner radius, the
// largest from the outer radius on, a smoothstep between. Mirrors radialBlurRadius in radial-focus.ts.
const radiusChunk = `
uniform vec2 focus;
uniform float innerRadius;
uniform float outerRadius;
uniform float maxBlur;
uniform float amount;

float radiusAt(vec2 pixel) {
	float t = clamp((distance(pixel, focus) - innerRadius) / max(outerRadius - innerRadius, 1e-6), 0.0, 1.0);
	return maxBlur * amount * t * t * (3.0 - 2.0 * t);
}
`;

// One disk gather from the full-resolution scene into a half-resolution target over the pixel's own
// radius. The radius is a smooth function of position, so no depth test is needed. The crisp set is
// drawn separately into `crispTexture`, and taps that land on it count for nothing: its colour is not
// part of the background, so it neither bleeds a halo around itself nor tints what lies around it.
// Half-resolution texel (i, j) stands for full-resolution pixel (2i, 2j).
const blurFragmentShader = `
${radiusChunk}
uniform sampler2D colorTexture;
uniform sampler2D crispTexture;
uniform vec2 fullSize;

const float GOLDEN_ANGLE = 2.39996323;

vec4 tap(vec2 pixel) {
	vec2 uv = pixel / fullSize;
	float open = 1.0 - texture2D(crispTexture, uv).a;
	return vec4(texture2D(colorTexture, uv).rgb * open, open);
}

void main() {
	vec2 centre = gl_FragCoord.xy * 2.0;
	float radius = radiusAt(centre);
	vec4 sum = tap(centre);
	if (radius >= ${RADIAL_MIN_BLUR_PIXELS.toFixed(2)}) {
		// Interleaved gradient noise turns the spiral's fixed tap pattern into fine noise that the
		// composite's bilinear upsample smooths, instead of hatching.
		float rotation = 6.28318531 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
		for (int index = 0; index < ${BLUR_TAPS}; index++) {
			float tapRadius = sqrt((float(index) + 0.5) / ${BLUR_TAPS}.0) * radius;
			float angle = float(index) * GOLDEN_ANGLE + rotation;
			sum += tap(centre + vec2(cos(angle), sin(angle)) * tapRadius);
		}
	}
	// Alpha rides along as the coverage of the taps that counted; every tap on the crisp set leaves
	// the pixel to the sharp scene, which the crisp set covers anyway.
	gl_FragColor = sum.a > 1e-4 ? vec4(sum.rgb / sum.a, 1.0) : texture2D(colorTexture, centre / fullSize);
}
`;

// Sharp where the radius is zero, blurred beyond, then the crisp set over it, then the vignette, which
// moves the colour toward the tone and reaches the corners most. Both fade with the whole effect.
const compositeFragmentShader = `
${radiusChunk}
uniform sampler2D sharpTexture;
uniform sampler2D blurTexture;
uniform sampler2D crispTexture;
uniform float vignette;
uniform vec3 vignetteTone;
varying vec2 vUv;

void main() {
	vec4 sharp = texelFetch(sharpTexture, ivec2(gl_FragCoord.xy), 0);
	vec4 blurred = texture2D(blurTexture, vUv);
	vec4 color = mix(sharp, blurred, smoothstep(0.0, 1.5, radiusAt(gl_FragCoord.xy)));
	// The crisp target holds premultiplied colour, so it lies over the image with one multiply-add.
	vec4 crisp = texelFetch(crispTexture, ivec2(gl_FragCoord.xy), 0);
	color = vec4(crisp.rgb + color.rgb * (1.0 - crisp.a), crisp.a + color.a * (1.0 - crisp.a));
	float corner = length(vUv * 2.0 - 1.0) / 1.41421356;
	float share = smoothstep(0.0, 1.0, clamp((corner - 0.45) / 0.55, 0.0, 1.0));
	color.rgb = mix(color.rgb, vignetteTone, share * vignette);
	gl_FragColor = color;
	${OUTPUT_COLOR_SPACE_FRAGMENT}
}
`;

function radiusUniforms() {
	return {
		amount: { value: 0 },
		focus: { value: new Vector2() },
		innerRadius: { value: 0 },
		maxBlur: { value: 0 },
		outerRadius: { value: 1 },
	};
}

function fullscreenMaterial(fragmentShader: string, uniforms: Record<string, { value: unknown }>) {
	return new ShaderMaterial({
		blending: NoBlending,
		depthTest: false,
		depthWrite: false,
		fragmentShader,
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
 * Radial focus: renders the scene into a target, blurs it at half resolution with a radius that
 * grows with the distance from the focus, composites onto the canvas with the optional vignette and
 * draws the crisp scene (the selection, its neighbours and their edges) over it unblurred. Three
 * extra draw calls plus the crisp set per frame while it runs. Created only while the effect has
 * something to blur; `dispose` releases every GPU resource.
 */
export class RadialFocusPass {
	private readonly sceneTarget: WebGLRenderTarget;
	private readonly crispTarget: WebGLRenderTarget;
	private readonly blurTarget: WebGLRenderTarget;
	private readonly blurMaterial = fullscreenMaterial(blurFragmentShader, {
		...radiusUniforms(),
		colorTexture: { value: null },
		crispTexture: { value: null },
		fullSize: { value: new Vector2() },
	});
	private readonly compositeMaterial = fullscreenMaterial(compositeFragmentShader, {
		...radiusUniforms(),
		blurTexture: { value: null },
		crispTexture: { value: null },
		sharpTexture: { value: null },
		vignette: { value: 0 },
		vignetteTone: { value: new Vector3() },
	});
	private readonly quad = new Mesh(fullscreenTriangle(), this.blurMaterial);
	private readonly quadScene = new Scene().add(this.quad);
	private readonly quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
	private readonly size = new Vector2();

	/** Radial focus needs WebGL 2 for texel fetches and sRGB render targets. */
	static isSupported(renderer: WebGLRenderer): boolean {
		return typeof WebGL2RenderingContext !== "undefined" && renderer.getContext() instanceof WebGL2RenderingContext;
	}

	constructor(antialias: boolean) {
		// sRGB storage keeps 8-bit targets free of banding in dark backgrounds without float extensions.
		const color = { colorSpace: SRGBColorSpace, type: UnsignedByteType } as const;
		this.sceneTarget = new WebGLRenderTarget(1, 1, { ...color, samples: antialias ? 4 : 0 });
		this.crispTarget = new WebGLRenderTarget(1, 1, { ...color, samples: antialias ? 4 : 0 });
		this.blurTarget = new WebGLRenderTarget(1, 1, color);
		this.quad.frustumCulled = false;
	}

	render(renderer: WebGLRenderer, scene: Scene, crispScene: Scene | null, camera: Camera, frame: RadialFocusFrame) {
		const { x: width, y: height } = renderer.getDrawingBufferSize(this.size);
		this.setSize(width, height);
		const previousTarget = renderer.getRenderTarget();

		renderer.setRenderTarget(this.sceneTarget);
		renderer.render(scene, camera);

		this.renderCrisp(renderer, crispScene, camera);

		const shared = {
			amount: frame.amount,
			focus: new Vector2(frame.focusX, frame.focusY),
			innerRadius: frame.innerPixels,
			maxBlur: frame.maxBlurPixels,
			outerRadius: frame.outerPixels,
		};
		this.quad.material = this.blurMaterial;
		this.setUniforms(this.blurMaterial, {
			...shared,
			colorTexture: this.sceneTarget.texture,
			crispTexture: this.crispTarget.texture,
			fullSize: new Vector2(width, height),
		});
		this.drawQuad(renderer, this.blurTarget);

		this.quad.material = this.compositeMaterial;
		this.setUniforms(this.compositeMaterial, {
			...shared,
			blurTexture: this.blurTarget.texture,
			crispTexture: this.crispTarget.texture,
			sharpTexture: this.sceneTarget.texture,
			vignette: frame.vignette,
			vignetteTone: new Vector3(...frame.vignetteTone),
		});
		this.drawQuad(renderer, previousTarget);
	}

	/** Draws the crisp set alone into a transparent target; nothing at all when there is none. */
	private renderCrisp(renderer: WebGLRenderer, crispScene: Scene | null, camera: Camera) {
		renderer.setRenderTarget(this.crispTarget);
		const clearColor = renderer.getClearColor(new Color());
		const clearAlpha = renderer.getClearAlpha();
		renderer.setClearColor(0x000000, 0);
		try {
			if (crispScene) renderer.render(crispScene, camera);
			else renderer.clear();
		} finally {
			renderer.setClearColor(clearColor, clearAlpha);
		}
	}

	dispose() {
		this.sceneTarget.dispose();
		this.crispTarget.dispose();
		this.blurTarget.dispose();
		this.blurMaterial.dispose();
		this.compositeMaterial.dispose();
		this.quad.geometry.dispose();
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
		this.crispTarget.setSize(width, height);
		this.blurTarget.setSize(Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2)));
	}
}
