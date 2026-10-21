"""Write the site's pages from README.md, which stays the one source.

The introduction is the README from its first paragraph to its first section; each other page is
one of its sections.

Usage: python3 docs/sync.py
"""

import re
from pathlib import Path

DOCS = Path(__file__).parent.resolve()
REPO = DOCS.parent
CONTENT = DOCS / "content"
# Each page: its title, description, layout, and the README heading it starts at and the one it ends before.
PAGES = {
    "index.smd": ("overwatch", "Test watchers that hand every failing build to the agent the moment it happens.", "index.shtml", "# overwatch", "## Watchers"),
    "watchers.smd": ("Watchers", "The test runners overwatch finds in a project, and how it reads what they print.", "page.shtml", "## Watchers", "## Per-project override"),
    "configuration.smd": ("Configuration", "Turning overwatch off, or giving a project its own commands, with .overwatch.json.", "page.shtml", "## Per-project override", "## Install"),
    "install.smd": ("Install", "Adding overwatch to Codex or Claude Code.", "page.shtml", "## Install", "## Neovim"),
    "neovim.smd": ("Neovim", "The same watchers beside the editor, with no agent involved.", "page.shtml", "## Neovim", "## Develop"),
    "develop.smd": ("Develop", "Running overwatch's own tests and trying a local checkout.", "page.shtml", "## Develop", None),
}


def section(readme: list[str], start: str, end: str | None) -> list[str]:
    """The README's lines after the heading start, up to the heading end or the end of the file, with its
    subheadings moved up to start at level 1, as SuperMD documents do."""
    depth = len(start.partition(" ")[0])
    first = readme.index(start)
    last = len(readme) if end is None else readme.index(end)
    assert first < last, f"README.md has '{end}' before '{start}'; keep the sections in order"
    body, fenced = [], False
    for line in readme[first + 1 : last]:
        fenced ^= line.startswith("```")
        body.append(heading(line[depth:]) if line.startswith("#") and not fenced else line)
    html = [line for line in body if line.startswith("<")]
    assert not html, f"SuperMD has no raw HTML; take {html[:2]} out of README.md's '{start}' section"
    assert any(line.strip() for line in body), f"README.md's '{start}' section is empty"
    return body


def heading(line: str) -> str:
    """A heading with the id GitHub gives it, so links to the README's sections work on the site too."""
    hashes, _, title = line.partition(" ")
    slug = re.sub(r"[^a-z0-9 -]", "", title.lower()).replace(" ", "-")
    assert set(hashes) == {"#"}, f"{line!r} is not a Markdown heading; pass a line beginning with one or more # characters"
    assert slug, f"the heading {line!r} has no letters or digits to make an id from; add a word or number"
    return f"{hashes} [{title}]($heading.id('{slug}'))"


def page(metadata: tuple[str, str, str], body: list[str], order: int) -> str:
    """A SuperMD page: its title, description and layout, then body. order sets the date, which orders the pages,
    newest first, so the first page has the latest."""
    title, description, layout = metadata
    assert '"' not in title + description, f"a quote in {title!r} or {description!r} would end the frontmatter string early"
    front = ["---", f'.title = "{title}",', f'.description = "{description}",', f'.date = .date("2026-10-21T00:00:{len(PAGES) - order:02}"),', f'.layout = "{layout}",', "---", ""]
    return "\n".join(front + body).rstrip() + "\n"


def main() -> None:
    readme = (REPO / "README.md").read_text().splitlines()
    assert readme[0] == "# overwatch", "README.md must start with its '# overwatch' title"
    for order, (name, (title, description, layout, start, end)) in enumerate(PAGES.items()):
        metadata = (title, description, layout)
        (CONTENT / name).write_text(page(metadata, section(readme, start, end), order))
        print(CONTENT / name)


if __name__ == "__main__":
    main()
