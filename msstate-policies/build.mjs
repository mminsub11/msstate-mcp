import { build } from "esbuild";
import { chmodSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

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

const workerCorpusPath = resolve(process.cwd(), "..", "worker", "corpus.json");
let courseCorpus = null;
let emergencyCorpus = null;
let tuitionCorpus = null;
try {
  const j = JSON.parse(readFileSync(workerCorpusPath, "utf8"));
  courseCorpus = j.courses ?? null;
  emergencyCorpus = j.emergency ?? null;
  tuitionCorpus = j.tuition ?? null;
} catch {
  // fine — initial build before corpus.json exists.
}

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist/index.js",
  minify: false,
  sourcemap: false,
  define: {
    __COURSE_CORPUS__: JSON.stringify(courseCorpus),
    __EMERGENCY_CORPUS__: JSON.stringify(emergencyCorpus),
    __TUITION_CORPUS__: JSON.stringify(tuitionCorpus),
  },
  banner: {
    js: [
      "#!/usr/bin/env node",
      `// msstate-policies-mcp ${pkg.version} ${gitSha} built ${builtAt}`,
    ].join("\n"),
  },
  logLevel: "info",
});

chmodSync("dist/index.js", 0o755);
