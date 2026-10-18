import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Host-provided packages the extension is allowed to require.
const KNOWN_HOST = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"] as const;
const HOST_IMPORT = /["'](@earendil-works\/[^"']+)["']/g;

/** @earendil-works/* package names imported by files the manifest ships. */
function publishedHostImports(): Set<string> {
	const files = ["index.ts"];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			const rel = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (rel !== "src/testing") walk(rel);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
				files.push(rel);
			}
		}
	};
	walk("src");
	const names = new Set<string>();
	for (const file of files) {
		const source = readFileSync(join(root, file), "utf8");
		for (const match of source.matchAll(HOST_IMPORT)) {
			names.add(match[1]!.split("/").slice(0, 2).join("/"));
		}
	}
	return names;
}

test("package.json is a discoverable pi package", async () => {
	const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	expect(pkg.keywords).toContain("pi-package");
	expect(Array.isArray(pkg.pi?.extensions) && pkg.pi.extensions.length > 0).toBe(true);
	for (const entry of pkg.pi.extensions) expect(existsSync(new URL(`../${entry}`, import.meta.url))).toBe(true);
	// host-provided packages: peerDependencies only, "*" range, never dependencies
	const host = Object.keys(pkg.peerDependencies ?? {}).filter((n) => n.startsWith("@earendil-works/"));
	expect(host).toContain("@earendil-works/pi-coding-agent");
	for (const n of host) expect(pkg.peerDependencies[n]).toBe("*");
	// no @earendil-works/* package may be a runtime dependency (iterate the known host list)
	for (const n of KNOWN_HOST) expect(pkg.dependencies?.[n]).toBeUndefined();
	// every host import reachable from the published `files` must resolve to a peerDependency
	for (const name of publishedHostImports()) {
		expect(pkg.peerDependencies?.[name]).toBe("*");
		expect(pkg.dependencies?.[name]).toBeUndefined();
	}
	// gallery previews + published file allowlist
	for (const key of ["image", "video"] as const) expect(String(pkg.pi?.[key])).toMatch(/^https:\/\//);
	for (const f of ["index.ts", "src/", "README.md"]) expect(pkg.files).toContain(f);
});
