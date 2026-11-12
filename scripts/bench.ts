// Runs the browser benchmark suite in headless Chromium and writes a JSON and a Markdown report.
//
//   bun run bench                          # whole suite, 3 fresh-page runs per case
//   BENCH_OUT=out/run1 bun run bench       # writes out/run1.json and out/run1.md
//   bun run bench --filter frame-2d --runs 5 --swiftshader
//
// Flags (or the matching BENCH_* environment variable):
//   --out <path>      BENCH_OUT         report path without extension (default bench-results/graphraum-bench)
//   --runs <n>        BENCH_RUNS        fresh-page runs per case (default 3)
//   --filter <text>   BENCH_FILTER      only cases whose id contains the text
//   --seed <n>        BENCH_SEED        shuffle seed, to replay an order (default: time based)
//   --angle <name>    BENCH_ANGLE       ANGLE backend (metal, d3d11, vulkan, gl). Default: metal on macOS, else Chromium's
//                                       choice. Headless Chromium alone falls back to SwiftShader (software), which has
//                                       no GPU timer, so name a real backend to measure the GPU
//   --swiftshader     BENCH_SWIFTSHADER force the software rasterizer, for repeatable pixels on any machine
//   --label <name>    BENCH_LABEL       name of this result set in the scaling chart legend (default: the commit)
//   --scaling                           run only the scaling ladder; --no-scaling runs everything else
//   BENCH_SCALING_CAP_S                 seconds one ladder case may take (default 300). A size over the cap, or a
//                                       crash/timeout, is recorded as skipped and larger sizes of that series are skipped
//   --list                              print the case ids and exit
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { BENCH_CASES } from "../bench/cases";
import { buildReport, type CaseRuns, renderMarkdown } from "../bench/report";
import { buildScalingFile } from "../bench/scaling";
import { renderScalingHtml } from "../bench/scaling-html";
import { shuffle } from "../bench/stats";
import type { BenchEnvironment, CasePageOutcome, CaseRunResult } from "../bench/types";

const CASE_TIMEOUT_MS = 15 * 60_000;

function option(name: string, env: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : process.env[env];
}

function flag(name: string, env: string) {
	return process.argv.includes(`--${name}`) || process.env[env] === "1";
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1)
		throw new Error(`${name} must be a positive integer, got "${value}".`);
	return parsed;
}

if (process.argv.includes("--list")) {
	for (const { descriptor } of BENCH_CASES) console.log(descriptor.id);
	process.exit(0);
}

const root = resolve(import.meta.dir, "..");
const filter = option("filter", "BENCH_FILTER");
const runs = positiveInteger(option("runs", "BENCH_RUNS"), 3, "BENCH_RUNS");
const seed = positiveInteger(option("seed", "BENCH_SEED"), Date.now() % 2_147_483_647, "BENCH_SEED");
const swiftshader = flag("swiftshader", "BENCH_SWIFTSHADER");
const outBase = resolve(
	root,
	(option("out", "BENCH_OUT") ?? "bench-results/graphraum-bench").replace(/\.(json|md)$/, ""),
);

const onlyScaling = process.argv.includes("--scaling");
const noScaling = process.argv.includes("--no-scaling");
const scalingCapMs = positiveInteger(process.env.BENCH_SCALING_CAP_S, 300, "BENCH_SCALING_CAP_S") * 1_000;
const selected = BENCH_CASES.filter(
	({ descriptor }) =>
		(!filter || descriptor.id.includes(filter)) &&
		(!onlyScaling || descriptor.group === "scaling") &&
		(!noScaling || descriptor.group !== "scaling"),
);
if (selected.length === 0) throw new Error(`No benchmark case matches "${filter}". Run with --list.`);

const server = await createServer({
	root,
	logLevel: "error",
	optimizeDeps: { include: ["three", "graphology"] },
	server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === "string") throw new Error("The benchmark server did not start.");
const origin = `http://127.0.0.1:${address.port}`;

const angle = swiftshader
	? "swiftshader"
	: (option("angle", "BENCH_ANGLE") ?? (process.platform === "darwin" ? "metal" : undefined));
const launchArgs = [
	...(angle ? [`--use-angle=${angle}`] : []),
	...(swiftshader ? ["--enable-unsafe-swiftshader"] : []),
	"--ignore-gpu-blocklist",
];

/** A new browser process per run: no shared heap, shader cache or GL context with an earlier case. */
async function runCase(
	id: string,
	timeoutMs = CASE_TIMEOUT_MS,
): Promise<{ browserVersion: string; outcome: CasePageOutcome }> {
	const browser = await chromium.launch({ args: launchArgs, headless: true });
	try {
		const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { height: 600, width: 800 } });
		const page = await context.newPage();
		page.on("pageerror", (error) => console.error(`  [page error] ${error.message}`));
		await page.goto(`${origin}/bench/case.html?case=${encodeURIComponent(id)}`);
		await page.waitForFunction(() => window.__benchOutcome !== undefined, undefined, {
			polling: 500,
			timeout: timeoutMs,
		});
		const outcome = (await page.evaluate(() => window.__benchOutcome)) as CasePageOutcome;
		return { browserVersion: `Chromium ${browser.version()}`, outcome };
	} finally {
		await browser.close();
	}
}

function git(...args: string[]) {
	const result = Bun.spawnSync(["git", ...args], { cwd: root });
	return result.stdout.toString().trim();
}

try {
	console.log(`Warming up the dev server at ${origin}`);
	const warmup = await runCase("warmup");
	if (!warmup.outcome.ok) throw new Error(`Warm-up failed: ${warmup.outcome.error}`);

	const jobs = shuffle(
		selected.flatMap(({ descriptor }) => Array.from({ length: runs }, (_, run) => ({ id: descriptor.id, run }))),
		seed,
	);
	const results = new Map<string, CaseRunResult[]>();
	const skipped = new Map<string, string>();
	/** Smallest size per ladder series that went over the cap or failed; larger sizes are not attempted. */
	const overCap = new Map<string, number>();
	let environment: BenchEnvironment | undefined;
	let browserVersion = warmup.browserVersion;
	for (const [position, job] of jobs.entries()) {
		const descriptor = selected.find((item) => item.descriptor.id === job.id)?.descriptor;
		const ladder = descriptor?.group === "scaling" ? descriptor : undefined;
		const blockedAt = ladder?.scalingSeries ? overCap.get(ladder.scalingSeries) : undefined;
		if (ladder && (skipped.has(job.id) || (blockedAt !== undefined && blockedAt < ladder.nodes))) {
			skipped.set(
				job.id,
				skipped.get(job.id) ??
					`skipped: ${blockedAt?.toLocaleString("en-US")} nodes already went over the ${scalingCapMs / 1_000} s cap`,
			);
			console.log(`[${position + 1}/${jobs.length}] ${job.id} run ${job.run + 1} skipped`);
			continue;
		}
		console.log(`[${position + 1}/${jobs.length}] ${job.id} run ${job.run + 1}`);
		const startedAt = Date.now();
		const stop = (reason: string) => {
			if (!ladder?.scalingSeries) throw new Error(reason);
			skipped.set(job.id, reason);
			overCap.set(ladder.scalingSeries, Math.min(overCap.get(ladder.scalingSeries) ?? ladder.nodes, ladder.nodes));
			console.log(`  ${reason}`);
		};
		let finished: Awaited<ReturnType<typeof runCase>>;
		try {
			finished = await runCase(job.id, ladder ? scalingCapMs : CASE_TIMEOUT_MS);
		} catch (error) {
			stop(
				`${job.id} did not finish within ${(Date.now() - startedAt) / 1_000} s: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
			);
			continue;
		}
		const { browserVersion: version, outcome } = finished;
		if (!outcome.ok) {
			stop(`failed: ${outcome.error.split("\n")[0]}`);
			continue;
		}
		browserVersion = version;
		environment ??= outcome.result.environment;
		results.set(job.id, [...(results.get(job.id) ?? []), outcome.result.run]);
		if (ladder?.scalingSeries && Date.now() - startedAt > scalingCapMs) {
			overCap.set(ladder.scalingSeries, Math.min(overCap.get(ladder.scalingSeries) ?? ladder.nodes, ladder.nodes));
		}
	}
	if (!environment) throw new Error("No benchmark case ran.");

	const cases: CaseRuns[] = selected.map(({ descriptor }) => ({ descriptor, runs: results.get(descriptor.id) ?? [] }));
	const report = buildReport({
		browserVersion,
		cases,
		commit: `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain", "--untracked-files=no") ? " (dirty)" : ""}`,
		environment,
		generatedAt: new Date().toISOString(),
		order: jobs.map((job) => `${job.id}#${job.run + 1}`),
		runs,
		seed,
		launchArgs,
	});
	mkdirSync(dirname(outBase), { recursive: true });
	writeFileSync(`${outBase}.json`, `${JSON.stringify(report, null, "\t")}\n`);
	writeFileSync(`${outBase}.md`, renderMarkdown(report));
	if (selected.some(({ descriptor }) => descriptor.group === "scaling")) {
		const label = option("label", "BENCH_LABEL") ?? report.commit;
		const scaling = buildScalingFile(report, label, skipped);
		writeFileSync(`${outBase}.scaling.json`, `${JSON.stringify(scaling, null, "\t")}\n`);
		writeFileSync(`${outBase}.scaling.html`, renderScalingHtml([scaling]));
		console.log(`Wrote ${outBase}.scaling.json and ${outBase}.scaling.html`);
	}
	console.log(`Wrote ${outBase}.json and ${outBase}.md (GL renderer: ${environment.glRenderer})`);
} finally {
	await server.close();
}
