import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

let gitSha = "unknown";
try {
  gitSha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  // not a git checkout — leave as "unknown"
}

const builtAt = new Date().toISOString();

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/index.js",
  minify: false,
  sourcemap: false,
  banner: {
    js: [
      "#!/usr/bin/env node",
      `// msstate-policies-mcp ${pkg.version} ${gitSha} built ${builtAt}`,
    ].join("\n"),
  },
  logLevel: "info",
});

chmodSync("dist/index.js", 0o755);
