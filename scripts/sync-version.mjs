#!/usr/bin/env node
/**
 * Copy msstate-policies/package.json#version into
 * msstate-policies/.claude-plugin/plugin.json#version. Single source of
 * truth is package.json — never hand-edit the plugin manifest's version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, "..", "msstate-policies", "package.json");
const manifestPath = resolve(
  here,
  "..",
  "msstate-policies",
  ".claude-plugin",
  "plugin.json",
);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.error(`sync-version: bumped plugin.json to ${pkg.version}`);
} else {
  console.error(`sync-version: plugin.json already at ${pkg.version}`);
}
