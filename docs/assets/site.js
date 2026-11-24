/**
 * The docs site's page behaviour: a table of contents that marks the heading in view, a search box over the
 * behavior guide's scenarios, and a copy button on each code block.
 *
 * Copyright (c) 2026 benomahony. SPDX-License-Identifier: MIT
 */

/** The page's tunable values, kept together. */
const SITE = {
  /** How long a copy button says "Copied", in milliseconds. */
  copiedMs: 1400,
  /** The part of the viewport a heading must be in to be the current one: below the header, in the top third. */
  currentHeading: "-90px 0px -68% 0px",
  /** What a copy button says, before and after a copy, and when the clipboard refused. */
  labels: { copy: "Copy", copied: "Copied", refused: "Select to copy" },
}

/**
 * Copies text to the clipboard, saying so on button for a moment, or telling the reader to select it when the
 * clipboard refuses. Resolves to whether it copied, so a caller can tell; throws a TypeError when given no button
 * or no text, since every copy button is made with both.
 */
function copyText(button, text) {
  if (!(button instanceof HTMLElement)) throw new TypeError(`copyText was given ${String(button)}; pass the copy button`)
  if (typeof text !== "string" || text.length === 0) throw new TypeError(`copyText was given no text for "${button.textContent}"; pass the code block's text`)
  console.assert(button.isConnected, `copy button "${button.textContent}" is not on the page; attach it before it is clicked`)
  console.assert(navigator.clipboard !== undefined, `no clipboard to copy ${text.length} characters to; serve the site over HTTPS`)
  return navigator.clipboard.writeText(text).then(() => {
    button.textContent = SITE.labels.copied
    setTimeout(() => { button.textContent = SITE.labels.copy }, SITE.copiedMs)
    return true
  }, () => {
    button.textContent = SITE.labels.refused
    return false
  })
}

/** A heading's text as an id: letters and digits of any script, lower-cased, each other run of characters one dash. */
function slugOf(text) {
  const slug = text.normalize("NFKC").toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")
  console.assert(!/[^\p{L}\p{N}-]/u.test(slug), `slug "${slug}" of "${text}" keeps a character an id should not; replace it with a dash`)
  console.assert(!slug.startsWith("-") && !slug.endsWith("-"), `slug "${slug}" of "${text}" starts or ends with a dash; trim them`)
  return slug
}

/** Lists the page's headings in the table of contents and marks the one in view. */
function buildToc() {
  const list = document.querySelector(".toc-list")
  const headings = document.querySelectorAll(".prose h2, .prose h3")
  if (!list || headings.length === 0) {
    document.querySelector(".toc")?.classList.add("empty")
    return
  }
  const anchors = [...headings].map((heading) => heading.parentElement.id ? heading.parentElement : heading)
  for (const [index, heading] of [...headings].entries()) {
    const anchor = anchors[index]
    anchor.id ||= slugOf(heading.textContent)
    const item = document.createElement("li")
    item.className = heading.tagName === "H3" ? "sub" : ""
    const link = document.createElement("a")
    link.href = `#${anchor.id}`
    link.textContent = heading.textContent
    item.appendChild(link)
    list.appendChild(item)
  }
  console.assert(list.children.length >= headings.length, `contents list ${list.children.length} entries for ${headings.length} headings; add one per heading`)
  console.assert(anchors.every((anchor) => anchor.id !== ""), `a heading of ${headings.length} has no id to link to; give each heading text`)
  const links = new Map([...list.querySelectorAll("a")].map((link) => [link.hash.slice(1), link]))
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      for (const link of links.values()) link.classList.remove("current")
      links.get(entry.target.id)?.classList.add("current")
    }
  }, { rootMargin: SITE.currentHeading })
  for (const anchor of anchors) observer.observe(anchor)
}

/** Shows the scenarios whose title, tags and steps hold every word of query, and how many that is, in count. */
function filterScenarios(filters, scenarios, sections, count) {
  const { query, agent } = filters
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  for (const scenario of scenarios) {
    const text = [...scenario.querySelectorAll("h4, .tag, .agent, li")].map((part) => part.textContent).join(" ").toLowerCase()
    const agents = [...scenario.querySelectorAll('.agent')].map(tag => tag.textContent)
    const agentMatches = !agent || (agent === 'general' ? agents.length === 0 : agents.includes(agent))
    scenario.hidden = !agentMatches || !words.every((word) => text.includes(word))
  }
  hideEmptySections(sections, scenarios)
  const shown = scenarios.filter((scenario) => !scenario.hidden).length
  console.assert(agent || words.length > 0 || shown === scenarios.length, `an empty search shows ${shown} of ${scenarios.length} scenarios; show them all`)
  count.textContent = countText(Boolean(agent) || words.length > 0, shown, scenarios.length)
  console.assert(count.textContent.includes(String(shown)) || shown === 0, `count "${count.textContent}" does not say ${shown} scenarios are shown`)
}

/**
 * Hides each feature heading with no scenario shown under it, and each status heading with no feature shown.
 * sections runs from the end of the guide to its start, so each scenario is seen before its feature heading and
 * each feature before its status.
 */
function hideEmptySections(sections, scenarios) {
  let feature = false
  let status = false
  for (const section of sections) {
    if (scenarios.includes(section)) {
      feature ||= !section.hidden
    } else if (section.querySelector("h3")) {
      section.hidden = !feature
      status ||= feature
      feature = false
    } else {
      section.hidden = !status
      status = false
    }
  }
  console.assert(!feature && !status, "a feature or status was left open at the start of the guide; start the guide with a status heading")
  console.assert(sections.every((section) => scenarios.includes(section) || typeof section.hidden === "boolean"), "a heading was neither hidden nor shown")
}

/** What the scenario count says: all of them before any search, else how many of total the search shows. */
function countText(isSearching, shown, total) {
  const text = !isSearching ? `${total} scenarios` : shown === 0 ? "No scenarios match" : `${shown} of ${total} scenarios`
  console.assert(text.length > 0, `count for ${shown} of ${total} scenarios is empty`)
  console.assert(isSearching || text.startsWith(String(total)), `count "${text}" before a search does not give the total ${total}`)
  return text
}

/** Build agent options from generated scenario metadata, including untagged scenarios. */
function createAgentFilter(scenarios) {
  const agents = [...new Set(scenarios.flatMap(scenario => [...scenario.querySelectorAll('.agent')].map(tag => tag.textContent)))].sort()
  console.assert(agents.length > 0, `No agent tags found in ${scenarios.length} scenarios`)
  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Filter by coding agent')
  select.append(new Option('All agents and integrations', ''))
  for (const agent of agents) select.append(new Option(agent, agent))
  if (scenarios.some(scenario => !scenario.querySelector('.agent'))) select.append(new Option('General / untagged', 'general'))
  console.assert(select.options.length > agents.length, `Agent filter lost its default option for ${agents}`)
  return select
}

/** Adds a box that filters the behavior guide's scenarios, hiding features and statuses left empty. */
function buildSearch() {
  const prose = document.querySelector(".prose")
  const scenarios = [...document.querySelectorAll(".prose > .verified, .prose > .unverified, .prose > .proposed")]
  if (!prose || scenarios.length === 0) return
  const search = document.createElement("div")
  search.className = "scenario-search"
  const input = document.createElement("input")
  input.type = "search"
  input.placeholder = "Search scenarios, steps, or tags"
  input.setAttribute("aria-label", "Search behavior")
  const count = document.createElement("p")
  count.className = "scenario-count"
  count.setAttribute("aria-live", "polite")
  const agent = createAgentFilter(scenarios)
  search.append(input, agent, count)
  prose.prepend(search)
  const sections = [...prose.querySelectorAll(":scope > div[id]")].toReversed()
  const filter = () => {
    console.assert(typeof input.value === "string" && input.isConnected, "the search box is not on the page; prepend it to .prose before filtering")
    filterScenarios({ query: input.value, agent: agent.value }, scenarios, sections, count)
    console.assert(count.textContent !== "", `filtering "${input.value}" left the count empty; filterScenarios must set it`)
  }
  input.addEventListener("input", filter)
  agent.addEventListener("change", filter)
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { input.value = ""; filter() }
  })
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.target instanceof HTMLInputElement) return
    event.preventDefault()
    input.focus()
  })
  for (const tag of prose.querySelectorAll(".tag, .agent")) {
    tag.addEventListener("click", () => { input.value = tag.textContent; filter(); input.focus() })
  }
  for (const scenario of scenarios) {
    const source = scenario.querySelector(":scope > p a")
    if (!source) continue
    scenario.addEventListener("click", (event) => {
      if (event.target.closest("a, .tag, .agent") || getSelection()?.toString()) return
      if (event.metaKey || event.ctrlKey) window.open(source.href, "_blank", "noopener")
      else location.href = source.href
    })
  }
  filter()
  console.assert(prose.firstElementChild === search, "the search box is not first in the guide; prepend it to .prose")
  console.assert(count.textContent === `${scenarios.length} scenarios`, `count "${count.textContent}" for ${scenarios.length} scenarios before any search`)
}

document.addEventListener("DOMContentLoaded", () => {
  buildToc()
  buildSearch()
  for (const pre of document.querySelectorAll(".prose pre")) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "copy floating"
    button.textContent = SITE.labels.copy
    button.addEventListener("click", () => void copyText(button, pre.querySelector("code")?.innerText ?? pre.innerText))
    pre.appendChild(button)
  }
})
