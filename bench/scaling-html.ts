import { crossing, FRAME_BUDGET_MS, fitLogLog, type ScalingFile } from "./scaling";

/** Drawing code that runs in the report page. The fit and crossing helpers are the same functions the Markdown uses. */
const CLIENT_SCRIPT = `
const BUDGET = ${FRAME_BUDGET_MS};
const COLORS = ["#2d8b6a", "#d9822b", "#4a6fd0", "#b04a8f", "#7a7a7a"];
const NS = "http://www.w3.org/2000/svg";
const files = JSON.parse(document.getElementById("data").textContent);
const charts = document.getElementById("charts");

function el(name, attrs, text) {
	const node = document.createElementNS(NS, name);
	for (const key of Object.keys(attrs || {})) node.setAttribute(key, String(attrs[key]));
	if (text !== undefined) node.textContent = text;
	return node;
}
function fmtNodes(n) { return n >= 1e6 ? n / 1e6 + "M" : n >= 1000 ? Math.round(n / 100) / 10 + "k" : String(Math.round(n)); }
function fmtMs(v) { return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toPrecision(2); }
function describe(e) { return e < 0.15 ? "flat" : e < 0.85 ? "sub-linear" : e <= 1.15 ? "linear" : e <= 1.6 ? "super-linear" : "steeper than n^1.6"; }

function drawSeries(id, title, entries) {
	const W = 680, H = 380, L = 56, R = 16, T = 16, B = 40;
	const measured = entries.flatMap(e => e.series.points.filter(p => p.median !== null));
	const section = document.createElement("section");
	const heading = document.createElement("h2");
	heading.textContent = title;
	section.append(heading);
	if (measured.length === 0) {
		const none = document.createElement("p");
		none.textContent = "No measurements (the metric was unavailable or every size was skipped).";
		section.append(none);
		charts.append(section);
		return;
	}
	const xs = entries.flatMap(e => e.series.points.map(p => p.nodes));
	const x0 = Math.log10(Math.min(...xs)), x1 = Math.log10(Math.max(...xs));
	const ys = measured.flatMap(p => [p.median, p.p95 === null ? p.median : p.p95]).concat([BUDGET]);
	const y0 = Math.floor(Math.log10(Math.min(...ys)) - 0.05), y1 = Math.ceil(Math.log10(Math.max(...ys)) + 0.05);
	const sx = n => L + (Math.log10(n) - x0) / Math.max(x1 - x0, 1e-9) * (W - L - R);
	const sy = v => T + (1 - (Math.log10(v) - y0) / Math.max(y1 - y0, 1e-9)) * (H - T - B);
	const svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title });
	for (let d = Math.ceil(x0); d <= Math.floor(x1); d += 1) {
		svg.append(el("line", { x1: sx(Math.pow(10, d)), x2: sx(Math.pow(10, d)), y1: T, y2: H - B, class: "grid" }));
	}
	for (const n of [...new Set(xs)]) svg.append(el("text", { x: sx(n), y: H - B + 16, class: "tick", "text-anchor": "middle" }, fmtNodes(n)));
	for (let d = y0; d <= y1; d += 1) {
		svg.append(el("line", { x1: L, x2: W - R, y1: sy(Math.pow(10, d)), y2: sy(Math.pow(10, d)), class: "grid" }));
		svg.append(el("text", { x: L - 6, y: sy(Math.pow(10, d)) + 4, class: "tick", "text-anchor": "end" }, fmtMs(Math.pow(10, d)) + " ms"));
	}
	svg.append(el("text", { x: (L + W - R) / 2, y: H - 6, class: "tick", "text-anchor": "middle" }, "nodes (edges = 3x), log scale"));
	svg.append(el("line", { x1: L, x2: W - R, y1: sy(BUDGET), y2: sy(BUDGET), class: "budget" }));
	svg.append(el("text", { x: W - R - 4, y: sy(BUDGET) - 5, class: "budget-label", "text-anchor": "end" }, "16.7 ms (60 fps)"));
	const notes = [];
	entries.forEach((entry, index) => {
		const color = COLORS[index % COLORS.length];
		const points = entry.series.points.filter(p => p.median !== null).sort((a, b) => a.nodes - b.nodes);
		if (points.length > 0) {
			const upper = points.map(p => sx(p.nodes) + "," + sy(p.p95 === null ? p.median : Math.max(p.p95, p.median)));
			const lower = points.slice().reverse().map(p => sx(p.nodes) + "," + sy(p.median));
			svg.append(el("polygon", { points: upper.concat(lower).join(" "), fill: color, opacity: 0.2 }));
			svg.append(el("polyline", { points: points.map(p => sx(p.nodes) + "," + sy(p.median)).join(" "), fill: "none", stroke: color, "stroke-width": 2 }));
			for (const p of points) svg.append(el("circle", { cx: sx(p.nodes), cy: sy(p.median), r: 3.5, fill: color }));
			const fit = fitLogLog(points);
			if (fit) {
				const a = points[0].nodes, b = points[points.length - 1].nodes;
				const at = n => Math.exp(fit.intercept + fit.exponent * Math.log(n));
				svg.append(el("line", { x1: sx(a), y1: sy(at(a)), x2: sx(b), y2: sy(at(b)), stroke: color, "stroke-dasharray": "2 4", "stroke-width": 1.5, opacity: 0.8 }));
			}
			const cross = crossing(points, BUDGET);
			if (cross && cross.kind === "interpolated") {
				svg.append(el("line", { x1: sx(cross.nodes), x2: sx(cross.nodes), y1: T, y2: H - B, stroke: color, "stroke-dasharray": "5 3", opacity: 0.6 }));
				svg.append(el("circle", { cx: sx(cross.nodes), cy: sy(BUDGET), r: 5, fill: "none", stroke: color, "stroke-width": 2 }));
			}
			notes.push({ color, label: entry.label, fit, cross });
		} else {
			notes.push({ color, label: entry.label, fit: null, cross: null });
		}
		const skipped = entry.series.points.filter(p => p.skipped);
		if (skipped.length > 0) notes[notes.length - 1].skipped = skipped.map(p => fmtNodes(p.nodes) + " (" + p.skipped + ")").join(", ");
	});
	section.append(svg);
	const list = document.createElement("ul");
	for (const note of notes) {
		const item = document.createElement("li");
		const swatch = document.createElement("span");
		swatch.className = "swatch";
		swatch.style.background = note.color;
		const parts = [note.label + ": "];
		parts.push(note.fit ? "scaling exponent ~" + note.fit.exponent.toFixed(2) + " (" + describe(note.fit.exponent) + ")" : "too few points for a fit");
		if (note.cross) parts.push(note.cross.kind === "always" ? "; over 16.7 ms even at " + fmtNodes(note.cross.nodes) + " nodes" : "; crosses 16.7 ms at ~" + fmtNodes(note.cross.nodes) + " nodes");
		else if (note.fit) parts.push("; stays under 16.7 ms across the measured range");
		if (note.skipped) parts.push("; skipped: " + note.skipped);
		item.append(swatch, document.createTextNode(parts.join("")));
		list.append(item);
	}
	section.append(list);
	charts.append(section);
}

function render() {
	charts.replaceChildren();
	const legend = document.getElementById("sets");
	legend.replaceChildren();
	files.forEach((file, index) => {
		const item = document.createElement("li");
		const swatch = document.createElement("span");
		swatch.className = "swatch";
		swatch.style.background = COLORS[index % COLORS.length];
		item.append(swatch, document.createTextNode(file.label + " | " + file.commit + " | " + file.environment.glRenderer + " | " + file.runs + " runs | " + file.generatedAt));
		legend.append(item);
	});
	const ids = [];
	const titles = {};
	for (const file of files) for (const s of file.series) { if (!ids.includes(s.id)) ids.push(s.id); titles[s.id] = s.title; }
	for (const id of ids) {
		drawSeries(id, titles[id], files.flatMap(file => { const series = file.series.find(s => s.id === id); return series ? [{ label: file.label, series }] : []; }));
	}
}

document.getElementById("add").addEventListener("change", async event => {
	for (const file of event.target.files) {
		try {
			const parsed = JSON.parse(await file.text());
			if (parsed.schema !== "graphraum-scaling/1") throw new Error("not a graphraum scaling file");
			files.push(parsed);
		} catch (error) {
			alert(file.name + ": " + error.message);
		}
	}
	render();
});
render();
`;

const STYLE = `
:root { color-scheme: light dark; --bg: #fbfbf9; --fg: #171717; --muted: #666; --grid: #d8d8d2; --budget: #c0392b; }
@media (prefers-color-scheme: dark) { :root { --bg: #111412; --fg: #ececec; --muted: #9a9a9a; --grid: #2c302c; --budget: #ff7b6b; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 760px; padding: 24px 16px 64px; }
h1 { font-size: 22px; } h2 { font-size: 16px; margin: 32px 0 8px; }
svg { width: 100%; height: auto; } .grid { stroke: var(--grid); stroke-width: 1; }
.tick { fill: var(--muted); font-size: 11px; } .budget { stroke: var(--budget); stroke-dasharray: 6 4; } .budget-label { fill: var(--budget); font-size: 11px; }
ul { padding-left: 0; list-style: none; margin: 4px 0; } li { margin: 2px 0; } .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
p, label { color: var(--muted); }
`;

/** Escapes `<` so embedded JSON can never close the script element. */
function embed(value: unknown) {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * A self-contained page (no network, inline SVG) with one log-log chart per metric. Each file is its own
 * series, so a baseline and a branch overlay; more files can be added in the page.
 */
export function renderScalingHtml(files: readonly ScalingFile[]): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>graphraum scaling</title>
<style>${STYLE}</style>
</head>
<body>
<h1>graphraum scaling</h1>
<p>Median line, shaded band up to p95, dotted line is the log-log fit (its slope is the scaling exponent: about 1 is linear). Dashed red line is the 60 fps budget. Absolute numbers are machine-specific; compare result sets from the same machine and GL renderer.</p>
<ul id="sets"></ul>
<label>Add result files: <input id="add" type="file" accept=".json,application/json" multiple></label>
<div id="charts"></div>
<script type="application/json" id="data">${embed(files)}</script>
<script>
${fitLogLog.toString()}
${crossing.toString()}
${CLIENT_SCRIPT}
</script>
</body>
</html>
`;
}
