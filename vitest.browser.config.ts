import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Real WebGL2 in headless Chromium. SwiftShader renders on the CPU, so CI needs no GPU and every
// run draws the same pixels. Unit tests with the fake renderer stay in `bun run test`.
export default defineConfig({
	test: {
		include: ["src/**/*.browser.test.ts"],
		browser: {
			enabled: true,
			headless: true,
			provider: playwright({
				launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
			}),
			instances: [{ browser: "chromium" }],
			viewport: { width: 800, height: 600 },
		},
	},
});
