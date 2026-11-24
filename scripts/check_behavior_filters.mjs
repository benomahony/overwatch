/** Verify agent selection composes with scenario search in the actual generated Behavior page. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { JSDOM } = require(process.env.MODEL_DOM_MODULE || 'jsdom')
const html = readFileSync(new URL('../docs/public/behavior/index.html', import.meta.url), 'utf8')
const dom = new JSDOM(html, { runScripts: 'dangerously' })
const { window } = dom
window.IntersectionObserver = class {
  observe(element) {
    assert(element.id, 'A contents anchor must have an ID')
    assert(element.isConnected, `Contents anchor ${element.id} must be attached`)
  }
}
const script = window.document.createElement('script')
script.textContent = readFileSync(new URL('../docs/public/site.js', import.meta.url), 'utf8')
window.document.head.append(script)
window.document.dispatchEvent(new window.Event('DOMContentLoaded'))
const scenarios = [...window.document.querySelectorAll('.prose > .verified, .prose > .unverified, .prose > .proposed')]
const select = window.document.querySelector('select[aria-label="Filter by coding agent"]')
const input = window.document.querySelector('input[type="search"]')
assert(select && input, 'Behavior must expose agent and text filters')
assert(scenarios.length > 0, `Behavior contains ${scenarios.length} scenarios; expected at least one`)
const options = [...select.options].filter(option => option.value && option.value !== 'general')
const fixtures = JSON.parse(readFileSync(new URL('../tests/fixtures/integration-contract.json', import.meta.url), 'utf8'))
assert.equal(options.length, new Set(fixtures.map(trace => trace.host)).size, 'Every fixture integration needs a filter option')
for (const option of options) {
  select.value = option.value
  select.dispatchEvent(new window.Event('change'))
  const expected = scenarios.filter(card => [...card.querySelectorAll('.agent')].some(tag => tag.textContent === option.value))
  assert.deepEqual(scenarios.filter(card => !card.hidden), expected, `${option.value} filter omitted or leaked scenarios`)
  input.value = 'no-scenario-has-this-text'
  input.dispatchEvent(new window.Event('input'))
  assert(scenarios.every(card => card.hidden), 'Text search must compose with the selected agent')
  assert.equal(window.document.querySelector('.scenario-count').textContent, 'No scenarios match')
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
  assert.deepEqual(scenarios.filter(card => !card.hidden), expected, 'Clearing search must retain agent selection')
}
select.value = 'general'
select.dispatchEvent(new window.Event('change'))
assert(scenarios.filter(card => !card.hidden).every(card => !card.querySelector('.agent')), 'General filter must not invent an agent for untagged scenarios')
select.value = ''
select.dispatchEvent(new window.Event('change'))
assert(scenarios.every(card => !card.hidden), 'Clearing agent selection must restore all scenarios')
dom.window.close()
process.stdout.write('Behavior agent filters and combined search verified\n')
