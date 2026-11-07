import type { Texture } from "three";

import type { GraphraumColor } from "./types";

/**
 * A grid of icon cells in one alpha-mask texture, built by `createIconAtlas` from the optional
 * `@yggy-tech/graphraum/icons` entry (or by the host). Only the alpha channel is read; the shader
 * tints it. The texture should have mipmaps, and the host owns and disposes it.
 */
export interface GraphraumIconAtlas {
	/** Number of icon cells; a node's `icon` is an index below it. */
	readonly count: number;
	/** Cells per row. Cell `i` sits at column `i % columns`, row `floor(i / columns)`, row 0 on top. */
	readonly columns: number;
	/** Fraction of each cell kept empty on every side, so mipmaps do not bleed into neighbours. */
	readonly padding: number;
	readonly rows: number;
	readonly texture: Texture;
}

export interface GraphraumIconOptions {
	/** Icon tint. Omitted: light on dark fills and dark on light fills, chosen per node from its fill. */
	color?: GraphraumColor;
	/** Half-extent of the icon artwork as a fraction of the node's half-height. Default 0.6. */
	scale?: number;
}

export const DEFAULT_ICON_SCALE = 0.6;

export function assertNodeIcon(nodeId: string, icon: number | undefined): void {
	if (icon !== undefined && (!Number.isInteger(icon) || icon < 0)) {
		throw new Error(`Node "${nodeId}" icon must be a non-negative integer index into the icon atlas`);
	}
}

export function assertNodeIconInAtlas(nodeId: string, icon: number | undefined, count: number): void {
	if (icon !== undefined && icon >= count) {
		throw new Error(
			`Node "${nodeId}" icon ${icon} is outside the icon atlas, which has ${count} icons (0 to ${count - 1})`,
		);
	}
}

export function assertIconAtlas(atlas: GraphraumIconAtlas): void {
	const { columns, count, padding, rows } = atlas;
	if (!Number.isInteger(count) || count < 1) throw new Error("Icon atlas count must be a positive integer");
	if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows < count) {
		throw new Error("Icon atlas columns and rows must be positive integers that hold every icon");
	}
	if (!Number.isFinite(padding) || padding < 0 || padding >= 0.5) {
		throw new Error("Icon atlas padding must be a fraction from 0 up to 0.5");
	}
}

export function assertIconScale(scale: number | undefined): void {
	if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0 || scale > 1)) {
		throw new Error("Icon scale must be a number above 0 and at most 1");
	}
}
