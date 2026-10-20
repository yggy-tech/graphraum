export const packageName = "@yggy-tech/graphraum";

export interface InstallCommand {
	manager: "npm" | "yarn" | "pnpm" | "bun";
	command: string;
}

/** One install command per package manager, in the order the docs tabs show them. */
export function installCommands(packageSpec: string = packageName): readonly InstallCommand[] {
	return [
		{ manager: "npm", command: `npm install ${packageSpec}` },
		{ manager: "yarn", command: `yarn add ${packageSpec}` },
		{ manager: "pnpm", command: `pnpm add ${packageSpec}` },
		{ manager: "bun", command: `bun add ${packageSpec}` },
	];
}
