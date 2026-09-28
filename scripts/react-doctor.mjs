#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(
  "npx",
  ["--yes", "react-doctor@latest", ".", "--yes", "--scope", "full", "--json"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  },
);
if (result.error || !result.stdout?.trim()) {
  console.error(result.error?.message ?? result.stderr ?? "React Doctor returned no report.");
  process.exit(1);
}
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error("React Doctor returned an invalid report:", result.stdout, result.stderr);
  process.exit(1);
}
const output = new URL("../node_modules/.cache/react-doctor/", import.meta.url);
mkdirSync(output, { recursive: true });
writeFileSync(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
for (const finding of report.diagnostics ?? []) {
  console.log(
    `${finding.filePath}:${finding.line} ${finding.severity} ${finding.plugin}/${finding.rule}: ${finding.message}`,
  );
}
const projects = report.projects ?? [];
const complete =
  report.ok === true &&
  report.mode === "full" &&
  report.reactDetected === true &&
  projects.length > 0 &&
  projects.every(
    (project) =>
      project.complete === true &&
      project.analyzedFileCount > 0 &&
      project.skippedChecks?.length === 0,
  );
const perfect =
  report.summary?.score === 100 && projects.every((project) => project.score?.score === 100);
console.log(
  `React Doctor ${report.version ?? ""}: ${report.summary?.score ?? "unavailable"}/100 (required: 100).`,
);
console.log("Report: node_modules/.cache/react-doctor/report.json");
if (!complete)
  console.error(
    "React Doctor did not complete every check; retry when the scanner and its services are available.",
  );
if (!perfect) console.error("Fix the findings and rerun the full scan to reach 100.");
process.exit(result.status === 0 && complete && perfect ? 0 : 1);
