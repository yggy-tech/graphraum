import type { ClusterTree } from "./cluster-tree";
import type { GraphraumColor, GraphraumNodeBlend } from "./types";

/** A compact member count: 950, 1.2k, 34k, 1.2M. */
export function formatCount(count: number): string {
	if (count < 1_000) return String(count);
	const [unit, suffix] = count < 1_000_000 ? [1_000, "k"] : [1_000_000, "M"];
	const scaled = count / unit;
	const text = scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, "") : String(Math.round(scaled));
	// 999.9k rounds up to 1000k; show it as 1M instead.
	return text === "1000" && suffix === "k" ? "1M" : `${text}${suffix}`;
}

const LABEL_CHARACTER_PIXELS = 6.6;
const LABEL_PADDING_PIXELS = 8;

/** Whether a glyph of this pixel radius is big enough to hold the label. */
export function labelFits(text: string, radiusPixels: number): boolean {
	return radiusPixels * 2 >= text.length * LABEL_CHARACTER_PIXELS + LABEL_PADDING_PIXELS;
}

/** Colour used for nodes without a parsable colour in `nodeColorKeys`. */
export const NEUTRAL_COLOR_KEY = 0x8a94a6;

function colorKey(color: GraphraumColor | undefined): number {
	if (typeof color === "number") return color & 0xffffff;
	if (typeof color !== "string") return NEUTRAL_COLOR_KEY;
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
	if (!hex) return NEUTRAL_COLOR_KEY;
	const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
	return Number.parseInt(full, 16);
}

/**
 * One 0xRRGGBB per node for `buildClusterTree({ colors })`. Hex strings (`#rgb`, `#rrggbb`) and numbers
 * are read; any other colour, and nodes without one, count as a neutral grey.
 */
export function nodeColorKeys(nodes: readonly { color?: GraphraumColor }[]): Uint32Array {
	return Uint32Array.from(nodes, (node) => colorKey(node.color));
}

const hex = (key: number) => `#${key.toString(16).padStart(6, "0")}`;

/** A colour above this share of a cluster is shown alone. */
const DOMINANT_SHARE = 0.8;
/** Colours under this share of a cluster do not get a blob. */
const MINIMUM_SHARE = 0.08;

/** The fill of an aggregate glyph from the colour summary of its cluster: the main colour and up to two blended ones. */
export function clusterFill(
	tree: ClusterTree,
	cluster: number,
): { blend?: readonly GraphraumNodeBlend[]; color?: string } {
	const { colorCount, colorKey: keys } = tree;
	if (!colorCount || !keys) return {};
	const members = tree.memberCount[cluster] as number;
	const share = (slot: number) => (colorCount[cluster * 3 + slot] as number) / members;
	const color = hex(keys[cluster * 3] as number);
	if (share(0) >= DOMINANT_SHARE) return { color };
	const blend = [1, 2]
		.filter((slot) => share(slot) >= MINIMUM_SHARE)
		.map((slot) => ({ color: hex(keys[cluster * 3 + slot] as number), weight: share(slot) }));
	return blend.length > 0 ? { blend, color } : { color };
}
