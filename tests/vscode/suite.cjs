const assert = require("node:assert/strict")
const { existsSync } = require("node:fs")
const { join } = require("node:path")
const vscode = require("vscode")

/** Waits until condition holds, failing after timeout milliseconds. */
async function until(condition, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!condition()) {
    assert(Date.now() < deadline, `condition ${condition} did not hold within ${timeout}ms`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

exports.run = async () => {
  const extension = vscode.extensions.getExtension("benomahony.overwatch")
  assert(extension, "VS Code did not load the overwatch extension; check package.json's publisher and name")
  await until(() => extension.isActive)
  const project = vscode.workspace.workspaceFolders[0].uri.fsPath
  await until(() => existsSync(join(project, "ran")))
  const commands = (await vscode.commands.getCommands(true)).filter(command => command.startsWith("overwatch."))
  assert.deepEqual(commands.sort(), ["overwatch.doctor", "overwatch.show", "overwatch.start", "overwatch.stop"])
  const report = await vscode.commands.executeCommand("overwatch.doctor")
  assert.equal(report[0], "overwatch doctor")
  assert(report.some(line => /^✓ project runs with sh: /.test(line)), `the doctor did not report the project's watcher:\n${report.join("\n")}`)
  await vscode.commands.executeCommand("overwatch.show")
  await vscode.commands.executeCommand("overwatch.stop")
}
