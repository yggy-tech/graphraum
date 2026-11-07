import type { GraphraumLabelStyle, GraphraumStyle, GraphraumStyleInput } from "./types";

/** Everything in a style except the theme colours. */
export type StyleExtras = Omit<GraphraumStyle, "theme">;

export const STYLE_DEFAULTS: StyleExtras = { edge: { markerSize: 1 }, label: {}, node: { strokeWidth: 0 } };

export function resolveStyleExtras(input: GraphraumStyleInput, base: StyleExtras): StyleExtras {
	const next = {
		edge: { ...base.edge, ...input.edge },
		label: { ...base.label, ...input.label },
		node: { ...base.node, ...input.node },
	};
	const entries = [
		["edge.markerSize", next.edge.markerSize],
		["node.strokeWidth", next.node.strokeWidth],
		...Object.entries(next.label),
	];
	const invalid = entries.find(([, value]) =>
		typeof value === "number" ? !(Number.isFinite(value) && value >= 0) : value?.trim() === "",
	);
	if (invalid) throw new Error(`Style ${invalid[0]} needs a number >= 0 or text, got "${invalid[1]}".`);
	return next;
}

export function applyLabelVariables(element: HTMLElement, label: GraphraumLabelStyle) {
	for (const [key, value] of Object.entries(label)) {
		const name = `--graphraum-label-${key}`;
		if (value === undefined) element.style.removeProperty(name);
		else element.style.setProperty(name, value);
	}
}
