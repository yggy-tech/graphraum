import { defineConfig } from "tsdown";

export default defineConfig({
	dts: true,
	entry: ["src/index.ts", "src/diagnostics.ts", "src/styles.ts", "src/layout-start.ts"],
	format: ["esm"],
	// The published JS drops comments; the .d.ts files keep the TSDoc for editors.
	outputOptions: { comments: false },
	platform: "browser",
});
