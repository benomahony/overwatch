import { runTests } from "@vscode/test-electron"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const project = mkdtempSync(join(tmpdir(), "overwatch-vscode-e2e-"))
writeFileSync(join(project, ".overwatch.json"), JSON.stringify({ baseline: ["sh", "-c", "touch ran; echo fail"], summary: "^(?:pass|fail)$", failed: "fail" }))

await runTests({
  extensionDevelopmentPath: fileURLToPath(new URL("../..", import.meta.url)),
  extensionTestsPath: fileURLToPath(new URL("suite.cjs", import.meta.url)),
  launchArgs: [project, "--disable-extensions", "--no-sandbox"],
})
