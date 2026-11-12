import { Color } from "three";
import type { GraphraumColor } from "./types";

/**
 * Resolves a color to a scratch `Color` that the next call overwrites, so read it out at once. Most
 * instances share a few colors, so the parse runs once per distinct value instead of once per instance.
 */
export function createColorResolver(): (value: GraphraumColor) => Color {
	const color = new Color();
	let source: GraphraumColor | undefined;
	return (value) => {
		if (value !== source) {
			source = value;
			// An unparsable value leaves `Color` as it was, so start from the white `new Color(value)` gives.
			color.setRGB(1, 1, 1).set(value);
		}
		return color;
	};
}
