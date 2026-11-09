import { describe, expect, test } from "vitest";

import { changedIds, type EdgePaintState, type EdgeStateStyling, resolveEdgePaint } from "./edge-state";

const defaults = { color: "#226f54", opacity: 0.55 };

function styling(states: Record<number, EdgePaintState>): EdgeStateStyling {
	return {
		dimmedColor: "#315a51",
		dimmedOpacity: 0.25,
		selectedColor: "#fcfffc",
		stateOf: (edgeIndex) => states[edgeIndex] ?? null,
	};
}

describe("resolveEdgePaint", () => {
	test("uses the edge visual in detail and theme defaults in overview", () => {
		const visual = { color: "#6d5bd0", opacity: 0.3 };
		expect(resolveEdgePaint(0, visual, defaults, "detail", undefined)).toEqual({ color: "#6d5bd0", opacity: 0.3 });
		expect(resolveEdgePaint(0, visual, defaults, "overview", undefined)).toEqual({ color: "#6d5bd0", opacity: 0.55 });
		expect(resolveEdgePaint(0, {}, defaults, "detail", undefined)).toEqual(defaults);
	});

	test("selection replaces the color and keeps the tier opacity", () => {
		const visual = { color: "#6d5bd0", opacity: 0.3 };
		expect(resolveEdgePaint(2, visual, defaults, "detail", styling({ 2: "selected" }))).toEqual({
			color: "#fcfffc",
			opacity: 0.3,
		});
		expect(resolveEdgePaint(1, visual, defaults, "detail", styling({ 2: "selected" }))).toEqual(visual);
	});
});

describe("resolveEdgePaint dimmed", () => {
	test("dimming replaces the color and never raises opacity", () => {
		expect(resolveEdgePaint(0, { color: "#6d5bd0" }, defaults, "detail", styling({ 0: "dimmed" }))).toEqual({
			color: "#315a51",
			opacity: 0.25,
		});
		expect(resolveEdgePaint(0, { opacity: 0.1 }, defaults, "detail", styling({ 0: "dimmed" }))).toEqual({
			color: "#315a51",
			opacity: 0.1,
		});
		expect(resolveEdgePaint(0, { opacity: 0.1 }, defaults, "overview", styling({ 0: "dimmed" }))).toEqual({
			color: "#315a51",
			opacity: 0.25,
		});
	});
});

describe("changedIds", () => {
	test("returns ids present in exactly one set", () => {
		expect(changedIds(new Set(["a", "b"]), new Set(["b", "c"])).sort()).toEqual(["a", "c"]);
		expect(changedIds(new Set(["a"]), new Set(["a"]))).toEqual([]);
	});
});

describe("resolveEdgePaint host colours", () => {
	const colored = (state: EdgePaintState): EdgeStateStyling => ({
		...styling({ 0: state }),
		colorOf: (edgeIndex) => (edgeIndex === 0 ? "#e8a33d" : null),
	});

	test("a host colour replaces the edge colour and keeps its opacity", () => {
		const visual = { color: "#6d5bd0", opacity: 0.3 };
		expect(resolveEdgePaint(0, visual, defaults, "detail", colored(null))).toEqual({ color: "#e8a33d", opacity: 0.3 });
		expect(resolveEdgePaint(1, visual, defaults, "detail", colored(null))).toEqual(visual);
	});

	test("selection and dimming win over a host colour", () => {
		expect(resolveEdgePaint(0, {}, defaults, "detail", colored("selected")).color).toBe("#fcfffc");
		expect(resolveEdgePaint(0, {}, defaults, "detail", colored("dimmed")).color).toBe("#315a51");
	});
});
