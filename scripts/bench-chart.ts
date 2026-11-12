// Overlays scaling result files (the *.scaling.json that `bun run bench` writes) in one HTML report.
//
//   bun scripts/bench-chart.ts --out compare.html baseline.scaling.json branch.scaling.json
//
// Each file becomes one series per chart, named by its label. The page can also add files in the browser.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isScalingFile, type ScalingFile } from "../bench/scaling";
import { renderScalingHtml } from "../bench/scaling-html";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : process.env.BENCH_CHART_OUT;
const inputs = args.filter((arg, index) => !arg.startsWith("--") && index !== outIndex + 1);
if (!out || inputs.length === 0) {
	console.error("Usage: bun scripts/bench-chart.ts --out <report.html> <result.scaling.json> [more.scaling.json ...]");
	process.exit(1);
}
const files = inputs.map((path): ScalingFile => {
	const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
	if (!isScalingFile(parsed)) throw new Error(`${path} is not a graphraum scaling file.`);
	return parsed;
});
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), renderScalingHtml(files));
console.log(`Wrote ${resolve(out)}`);
