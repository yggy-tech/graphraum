/** Icons entry (`@yggy-tech/graphraum/icons`): builds the icon atlas for `Graphraum.setIconAtlas`. */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace } from "three";

import type { GraphraumIconAtlas } from "./node-icon";

/** An SVG document as a string, or any decoded image the canvas can draw. */
export type GraphraumIconSource = string | CanvasImageSource;

export interface CreateIconAtlasOptions {
	/** Largest icon size in CSS pixels the atlas should stay sharp at. Default 32. */
	size?: number;
	/** Rasterisation scale; 2 keeps icons sharp on retina screens. Default 2. */
	pixelRatio?: number;
}

export interface GraphraumIconAtlasBuild extends GraphraumIconAtlas {
	readonly buildMilliseconds: number;
	/** Releases the atlas texture. Call it once no graph uses the atlas. */
	dispose(): void;
}

/** Fraction of each cell left empty on every side; the shader and the atlas agree on it. */
const ICON_PADDING = 0.125;
const MAX_ICONS = 1024;

/** Draws SVG strings and images into one cell each of an alpha-mask atlas with mipmaps. */
export async function createIconAtlas(
	icons: readonly GraphraumIconSource[],
	options: CreateIconAtlasOptions = {},
): Promise<GraphraumIconAtlasBuild> {
	const started = performance.now();
	const { pixelRatio = 2, size = 32 } = options;
	if (icons.length === 0) throw new Error("createIconAtlas needs at least one icon");
	if (icons.length > MAX_ICONS)
		throw new Error(`createIconAtlas takes at most ${MAX_ICONS} icons, got ${icons.length}`);
	if (!(size > 0) || !(pixelRatio > 0)) throw new Error("createIconAtlas size and pixelRatio must be positive numbers");

	const cell = Math.ceil(size * pixelRatio);
	const columns = Math.ceil(Math.sqrt(icons.length));
	const rows = Math.ceil(icons.length / columns);
	const canvas = document.createElement("canvas");
	canvas.width = columns * cell;
	canvas.height = rows * cell;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("createIconAtlas needs a 2D canvas context");

	const margin = Math.round(cell * ICON_PADDING);
	const artwork = cell - margin * 2;
	const images = await Promise.all(icons.map((icon, index) => decode(icon, index)));
	for (const [index, image] of images.entries()) {
		const x = (index % columns) * cell + margin;
		const y = Math.floor(index / columns) * cell + margin;
		context.drawImage(image, x, y, artwork, artwork);
	}

	const texture = new CanvasTexture(canvas);
	// Row 0 is the top of the canvas at v = 0; only the alpha channel is read.
	texture.flipY = false;
	texture.colorSpace = NoColorSpace;
	texture.generateMipmaps = true;
	texture.minFilter = LinearMipmapLinearFilter;
	texture.magFilter = LinearFilter;
	return {
		buildMilliseconds: performance.now() - started,
		columns,
		count: icons.length,
		dispose: () => texture.dispose(),
		padding: ICON_PADDING,
		rows,
		texture,
	};
}

async function decode(icon: GraphraumIconSource, index: number): Promise<CanvasImageSource> {
	if (typeof icon !== "string") return icon;
	if (!icon.includes("<svg")) throw new Error(`Icon ${index} is a string but not SVG markup`);
	const image = new Image();
	image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(icon)}`;
	try {
		await image.decode();
	} catch {
		throw new Error(`Icon ${index} is not a valid SVG image; check its markup and that it declares xmlns`);
	}
	return image;
}

/**
 * Makes a raw Phosphor SVG (for example `@phosphor-icons/core/assets/regular/buildings.svg?raw`)
 * safe to rasterise: declares the SVG namespace and a fixed size when the file omits them, and
 * paints with a solid colour instead of `currentColor`. graphraum bundles no Phosphor code; the
 * host imports the icons it needs.
 */
export function phosphorIcon(svg: string): string {
	const open = svg.match(/<svg\b[^>]*>/)?.[0];
	if (!open) throw new Error("phosphorIcon expects an SVG string");
	let patched = open;
	if (!/\bxmlns=/.test(patched)) patched = patched.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
	if (!/\bwidth=/.test(patched)) patched = patched.replace("<svg", '<svg width="256" height="256"');
	return svg.replace(open, patched).replaceAll("currentColor", "#000");
}
