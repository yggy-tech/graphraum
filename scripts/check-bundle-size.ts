// Fails when the published bundle grows past its budget. Raise a budget on purpose, in the same PR
// that explains the growth; three.js stays a peer and is not counted. An entry counts together with
// the local chunks it imports, so code shared between entries still counts against the main entry.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

// 64 000 since lit and toon shading (#165): the light shader and scene option validation.
// 66 000 since layout styles (#191): edge-t, plus room for the planned styles in #170, #192 and #193.
// 70 000 since the focus lens: the per-frame size pass, lens-aware picking, label opacity and its option checks.
// 1 500 for the styles entry (#203): four presets as plain objects, kept out of the main bundle.
// 4 500 for the layout-start entry (#193): pivot MDS, kept out of the main entry (3.3 KiB when added).
const BUDGETS = [
	{ file: "dist/index.js", gzipBytes: 70_000 },
	{ file: "dist/styles.js", gzipBytes: 1_500 },
	{ file: "dist/layout-start.js", gzipBytes: 4_500 },
];

const LOCAL_IMPORT = /\bfrom\s*["'](\.\/[^"']+\.js)["']/g;

/** The entry plus every local chunk it imports, each counted once. */
async function bundleOf(entry: string): Promise<Uint8Array> {
	const seen = new Set<string>();
	const parts: Uint8Array[] = [];
	async function visit(file: string) {
		if (seen.has(file)) return;
		seen.add(file);
		const source = Bun.file(file);
		if (!(await source.exists())) throw new Error(`${file} is missing. Run \`bun run build\` first.`);
		const text = await source.text();
		parts.push(new TextEncoder().encode(text));
		for (const [, chunk] of text.matchAll(LOCAL_IMPORT)) await visit(join(dirname(file), chunk ?? ""));
	}
	await visit(entry);
	return Buffer.concat(parts);
}

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
const rows: string[] = [];
let failed = false;

for (const { file, gzipBytes } of BUDGETS) {
	const bytes = await bundleOf(file);
	const gzip = Bun.gzipSync(bytes).length;
	const over = gzip > gzipBytes;
	failed ||= over;
	rows.push(
		`| \`${file}\` | ${kib(bytes.length)} | ${kib(gzip)} | ${kib(gzipBytes)} | ${over ? "over budget" : "ok"} |`,
	);
}

const table = ["| File | Raw | Gzip | Budget (gzip) | Status |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Bundle size\n\n${table}\n`);
if (failed) {
	console.error("Bundle over budget. Shrink it, or raise the budget in scripts/check-bundle-size.ts and say why.");
	process.exit(1);
}
