import { assert } from './assert'

/** Only explicitly protected actions are subject to a pre-tool failure gate. */
export type GatePolicy = {
  inherited?: 'allow' | 'block'
  protected_actions?: { tool: string; command?: string; checks?: string[] }[]
}

/** Undefined means unprotected; an empty list selects every check. */
export function protectedChecks(tool: string, input: object, policy: GatePolicy): string[] | undefined {
  const arguments_ = input as Record<string, unknown>
  const command = String(arguments_.command ?? arguments_.cmd ?? '')
  const names = new Set<string>()
  let matched = false
  for (const action of policy.protected_actions ?? []) {
    if (action.tool.toLowerCase() !== tool.toLowerCase()) continue
    if (action.command !== undefined && !new RegExp(action.command).test(command)) continue
    matched = true
    if (!action.checks?.length) return []
    for (const name of action.checks) names.add(name)
  }
  assert(matched || names.size === 0, `no action protects ${tool} yet it selected checks ${[...names]}; select only from matching actions`)
  assert([...names].every(name => name !== ''), `${tool} selected an unnamed check from ${[...names]}; name each check in .overwatch.json`)
  return matched ? [...names] : undefined
}
