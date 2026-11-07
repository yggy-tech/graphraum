import { defineConfig } from "tsdown";

export default defineConfig({
	dts: true,
	entry: ["src/index.ts", "src/diagnostics.ts", "src/styles.ts", "src/layout-start.ts"],
	format: ["esm"],
	platform: "browser",
});
