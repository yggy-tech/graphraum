import { describe, expect, it } from "vitest";
import { applyLabelVariables, resolveStyleExtras, STYLE_DEFAULTS } from "./style";
import { graphraumStylePresets } from "./styles";
import { graphraumThemeDark, graphraumThemeLight, resolveGraphraumTheme } from "./theme";

function fakeElement() {
	const properties = new Map<string, string>();
	const element = {
		style: {
			removeProperty: (name: string) => properties.delete(name),
			setProperty: (name: string, value: string) => properties.set(name, value),
		},
	};
	return { element: element as unknown as HTMLElement, properties };
}

describe("resolveStyleExtras", () => {
	it("keeps today's values when nothing is given", () => {
		expect(resolveStyleExtras({}, STYLE_DEFAULTS)).toEqual({
			edge: { markerSize: 1 },
			label: {},
			node: { strokeWidth: 0 },
		});
	});

	it("merges field by field without mutating the base", () => {
		const base = resolveStyleExtras({ label: { font: "serif", fg: "#111" } }, STYLE_DEFAULTS);
		const next = resolveStyleExtras({ node: { strokeWidth: 2 }, label: { fg: "#222" } }, base);
		expect(next).toEqual({ edge: { markerSize: 1 }, label: { font: "serif", fg: "#222" }, node: { strokeWidth: 2 } });
		expect(base.node.strokeWidth).toBe(0);
		expect(STYLE_DEFAULTS.label).toEqual({});
	});

	it.each([
		[{ node: { strokeWidth: -1 } }, /node\.strokeWidth/],
		[{ node: { strokeWidth: Number.NaN } }, /node\.strokeWidth/],
		[{ edge: { markerSize: -2 } }, /edge\.markerSize/],
		[{ label: { font: "" } }, /font/],
		[{ label: { fg: "   " } }, /fg/],
	])("rejects %j with an actionable error", (input, message) => {
		expect(() => resolveStyleExtras(input, STYLE_DEFAULTS)).toThrow(message);
	});
});

describe("applyLabelVariables", () => {
	it("writes only the fields the label sets", () => {
		const { element, properties } = fakeElement();
		applyLabelVariables(element, { bg: "white", font: "serif", size: "13px" });
		expect(Object.fromEntries(properties)).toEqual({
			"--graphraum-label-bg": "white",
			"--graphraum-label-font": "serif",
			"--graphraum-label-size": "13px",
		});
	});

	it("clears a field whose value is undefined", () => {
		const { element, properties } = fakeElement();
		applyLabelVariables(element, { bg: "white", fg: "black" });
		applyLabelVariables(element, { bg: undefined, fg: "black" });
		expect(Object.fromEntries(properties)).toEqual({ "--graphraum-label-fg": "black" });
	});
});

describe("graphraumStylePresets", () => {
	it("classicDark and classicLight are exactly today's themes", () => {
		expect(graphraumStylePresets.classicDark.theme).toEqual(graphraumThemeDark);
		expect(graphraumStylePresets.classicLight.theme).toEqual(graphraumThemeLight);
		expect(graphraumStylePresets.classicDark).toMatchObject({ edge: { markerSize: 1 }, node: { strokeWidth: 0 } });
	});

	it.each(Object.entries(graphraumStylePresets))("%s is valid", (_name, preset) => {
		expect(() => resolveStyleExtras(preset, STYLE_DEFAULTS)).not.toThrow();
		expect(() => resolveGraphraumTheme(preset.theme)).not.toThrow();
	});

	it("applying a classic preset after another preset clears its label", () => {
		const blueprint = resolveStyleExtras(graphraumStylePresets.blueprint, STYLE_DEFAULTS);
		const back = resolveStyleExtras(graphraumStylePresets.classicDark, blueprint);
		const { element, properties } = fakeElement();
		applyLabelVariables(element, blueprint.label);
		expect(properties.size).toBeGreaterThan(0);
		applyLabelVariables(element, back.label);
		expect(properties.size).toBe(0);
	});

	it("only neutral is transparent and brand-free", () => {
		expect(graphraumStylePresets.neutral.theme.background).toBeNull();
		expect(JSON.stringify(graphraumStylePresets.neutral)).not.toMatch(/226f54|040f0f|fcfffc/i);
	});
});
