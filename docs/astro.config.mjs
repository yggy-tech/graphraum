import { fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import remarkMermaid from "./src/plugins/remark-mermaid.ts";

const docsThreePath = fileURLToPath(new URL("./node_modules/three", import.meta.url));

export default defineConfig({
	site: "https://yggy-tech.github.io",
	base: "/graphraum",
	integrations: [
		starlight({
			title: "graphraum",
			description: "yggy's WebGL engine for interactive graphs in 2D and 3D.",
			logo: {
				dark: "./src/assets/logo-dark.svg",
				light: "./src/assets/logo-light.svg",
				alt: "",
			},
			customCss: ["./src/styles/custom.css"],
			components: {
				Head: "./src/components/Head.astro",
				SiteTitle: "./src/components/SiteTitle.astro",
			},
			sidebar: [
				{
					label: "Start",
					items: [
						{ label: "Get started", link: "/get-started/" },
						{ label: "Why graphraum", link: "/why-graphraum/" },
					],
				},
				{
					label: "Guide",
					items: [
						{ label: "Data and visuals", link: "/guide/data-and-visuals/" },
						{ label: "Labels and focus", link: "/guide/labels-and-focus/" },
						{ label: "Layout", link: "/guide/layout/" },
						{ label: "Camera and 3D", link: "/guide/camera-and-3d/" },
						{ label: "Theme", link: "/guide/theme/" },
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "API", link: "/reference/api/" },
						{ label: "Architecture", link: "/reference/architecture/" },
						{ label: "Changelog", link: "/reference/changelog/" },
					],
				},
			],
		}),
	],
	// GFM (tables, strikethrough, autolinks) is not on by default in this Astro/Starlight setup.
	markdown: { gfm: true, remarkPlugins: [remarkMermaid] },
	vite: {
		resolve: {
			alias: {
				"@yggy-tech/graphraum": fileURLToPath(new URL("../src/index.ts", import.meta.url)),
				three: docsThreePath,
			},
		},
	},
});
