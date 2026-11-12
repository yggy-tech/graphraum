import { findCase } from "./cases";
import { readEnvironment } from "./measure";
import type { CasePageOutcome } from "./types";

declare global {
	interface Window {
		/** Set when the case finishes; the runner polls for it. */
		__benchOutcome?: CasePageOutcome;
		/** Last progress note, for the runner's log and for debugging a stuck case. */
		__benchProgress?: string;
	}
}

/** One case per page load, so every run starts from a cold heap, cold shaders and a fresh GL context. */
async function main(): Promise<CasePageOutcome> {
	const id = new URLSearchParams(location.search).get("case") ?? "";
	const benchCase = findCase(id);
	if (!benchCase) return { error: `Unknown benchmark case "${id}".`, ok: false };
	const container = document.querySelector<HTMLElement>("#graph");
	if (!container) return { error: "Benchmark container #graph is missing.", ok: false };
	const environment = readEnvironment();
	const run = await benchCase.run(container);
	return { ok: true, result: { descriptor: benchCase.descriptor, environment, run } };
}

main().then(
	(outcome) => {
		window.__benchOutcome = outcome;
	},
	(error: unknown) => {
		window.__benchOutcome = {
			error: error instanceof Error ? (error.stack ?? error.message) : String(error),
			ok: false,
		};
	},
);
