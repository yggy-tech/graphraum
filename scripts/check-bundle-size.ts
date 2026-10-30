// Fails when the published bundle grows past its budget. Raise a budget on purpose, in the same PR
// that explains the growth; three.js stays a peer and is not counted.
import { appendFileSync } from "node:fs";

const BUDGETS = [{ file: "dist/index.js", gzipBytes: 62_000 }];

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;
const rows: string[] = [];
let failed = false;

for (const { file, gzipBytes } of BUDGETS) {
	const source = Bun.file(file);
	if (!(await source.exists())) throw new Error(`${file} is missing. Run \`bun run build\` first.`);
	const bytes = await source.bytes();
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
