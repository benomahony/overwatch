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
  for (const heading of headings) {
    heading.id ||= heading.textContent.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
    const item = document.createElement("li")
    item.className = heading.tagName === "H3" ? "sub" : ""
    const link = document.createElement("a")
    link.href = `#${heading.id}`
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
  for (const heading of headings) observer.observe(heading)
}

document.addEventListener("DOMContentLoaded", () => {
  buildToc()
  for (const pre of document.querySelectorAll(".prose pre")) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "copy floating"
    button.textContent = "Copy"
    button.addEventListener("click", () => copyText(button, pre.querySelector("code")?.innerText ?? pre.innerText))
    pre.appendChild(button)
  }
})
