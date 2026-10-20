import { describe, expect, test } from "vitest";

import { installCommands } from "./install-commands";

describe("install commands", () => {
	test("offers every package manager for the unpinned package", () => {
		expect(installCommands()).toEqual([
			{ manager: "npm", command: "npm install @yggy-tech/graphraum" },
			{ manager: "yarn", command: "yarn add @yggy-tech/graphraum" },
			{ manager: "pnpm", command: "pnpm add @yggy-tech/graphraum" },
			{ manager: "bun", command: "bun add @yggy-tech/graphraum" },
		]);
	});

	test("pins every command to a release spec", () => {
		expect(installCommands("@yggy-tech/graphraum@0.4.0").map(({ command }) => command)).toEqual([
			"npm install @yggy-tech/graphraum@0.4.0",
			"yarn add @yggy-tech/graphraum@0.4.0",
			"pnpm add @yggy-tech/graphraum@0.4.0",
			"bun add @yggy-tech/graphraum@0.4.0",
		]);
	});
});
