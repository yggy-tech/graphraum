/** What one case run reports from a fresh page. Cold values are single numbers; warm values are per-frame samples. */
export interface CaseRunResult {
	/** One-off costs measured on the first pass (construction, first frame, worker phases). */
	cold: Record<string, number | null>;
	/** Repeated samples after warm-up. `null` marks a sample the browser could not provide (GPU timer). */
	warm: Record<string, (number | null)[]>;
}

export interface BenchEnvironment {
	devicePixelRatio: number;
	glRenderer: string;
	glVendor: string;
	/** True when `EXT_disjoint_timer_query_webgl2` is available, so GPU samples are real numbers. */
	gpuTimer: boolean;
	maxPixelRatio: number;
	/** True when the renderer string names a software rasterizer (SwiftShader, llvmpipe), so GPU numbers are CPU numbers. */
	softwareRenderer: boolean;
	userAgent: string;
	viewport: { height: number; width: number };
}

export interface CaseDescriptor {
	/** Which table the case belongs to; see `GROUP_COLUMNS` in report.ts. */
	group: BenchGroup;
	id: string;
	mode: "2d" | "3d";
	nodes: number;
	edges: number;
	/** One sentence, printed in the report so a number is never separated from its protocol. */
	protocol: string;
	/** Scaling-ladder cases only: the family (`pan2d`, `load`, ...) this size belongs to. */
	scalingSeries?: string;
	title: string;
}

export const BENCH_GROUPS = ["frame", "selection", "layout", "glow", "orbit", "scaling"] as const;
export type BenchGroup = (typeof BENCH_GROUPS)[number];

export interface CasePageResult {
	descriptor: CaseDescriptor;
	environment: BenchEnvironment;
	run: CaseRunResult;
}

export type CasePageOutcome = { error: string; ok: false } | { ok: true; result: CasePageResult };
