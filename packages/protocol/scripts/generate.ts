/**
 * Writes the generated protocol artifacts to the repository.
 *
 * Run with `pnpm --filter @mfc/protocol generate`. The generated files are committed,
 * so CI can detect drift by regenerating and checking `git status`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArtifacts } from "./artifacts";

// This script lives in packages/protocol/scripts, so three levels up is the repository root.
const repositoryRoot = new URL("../../../", import.meta.url);

for (const [relativePath, content] of buildArtifacts()) {
  const target = fileURLToPath(new URL(relativePath, repositoryRoot));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  console.log(`wrote ${relativePath}`);
}
