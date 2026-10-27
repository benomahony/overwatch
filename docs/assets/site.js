function copyText(button, text) {
  if (!(button instanceof HTMLElement) || typeof text !== "string" || text.length === 0) return
  navigator.clipboard.writeText(text).then(() => {
    const label = button.textContent
    button.textContent = "Copied"
    setTimeout(() => { button.textContent = label }, 1400)
  }).catch(() => { button.textContent = "Select to copy" })
}

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
    anchor.id ||= heading.textContent.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
    const item = document.createElement("li")
    item.className = heading.tagName === "H3" ? "sub" : ""
    const link = document.createElement("a")
    link.href = `#${anchor.id}`
    link.textContent = heading.textContent
    item.appendChild(link)
    list.appendChild(item)
  }
  const links = new Map([...list.querySelectorAll("a")].map((link) => [link.hash.slice(1), link]))
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      for (const link of links.values()) link.classList.remove("current")
      links.get(entry.target.id)?.classList.add("current")
    }
  }, { rootMargin: "-90px 0px -68% 0px" })
  for (const anchor of anchors) observer.observe(anchor)
}

function buildSearch() {
  const prose = document.querySelector(".prose")
  const scenarios = [...document.querySelectorAll(".prose > .verified, .prose > .proposed")]
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
  search.append(input, count)
  prose.prepend(search)
  const sections = [...prose.querySelectorAll(":scope > div[id]")].toReversed()
  const filter = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean)
    for (const scenario of scenarios) {
      const text = scenario.textContent.toLowerCase()
      scenario.hidden = !words.every((word) => text.includes(word))
    }
    let feature = false, status = false
    for (const section of sections) {
      if (scenarios.includes(section)) feature ||= !section.hidden
      else if (section.querySelector("h3")) { section.hidden = !feature; status ||= feature; feature = false }
      else { section.hidden = !status; status = false }
    }
    const shown = scenarios.filter((scenario) => !scenario.hidden).length
    count.textContent = words.length === 0 ? `${scenarios.length} scenarios`
      : shown === 0 ? "No scenarios match" : `${shown} of ${scenarios.length} scenarios`
  }
  input.addEventListener("input", filter)
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { input.value = ""; filter() }
  })
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.target instanceof HTMLInputElement) return
    event.preventDefault()
    input.focus()
  })
  for (const tag of prose.querySelectorAll(".tag")) {
    tag.addEventListener("click", () => { input.value = tag.textContent; filter(); input.focus() })
  }
  filter()
}

document.addEventListener("DOMContentLoaded", () => {
  buildToc()
  buildSearch()
  for (const pre of document.querySelectorAll(".prose pre")) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "copy floating"
    button.textContent = "Copy"
    button.addEventListener("click", () => copyText(button, pre.querySelector("code")?.innerText ?? pre.innerText))
    pre.appendChild(button)
  }
})
