"""Write site pages from README.md and the generated acceptance-scenario document.

The introduction is the README from its first paragraph to its first section; each other page is
one of its sections.

Usage: python3 docs/sync.py          # list pages that are out of date, exiting 1 if any are
       python3 docs/sync.py --write  # rewrite exactly those pages
"""

import argparse
import fcntl
import json
import re
import sys
import unicodedata
from pathlib import Path

DOCS = Path(__file__).parent.resolve()
REPO = DOCS.parent
DATE = "2026-10-21"
TITLE = re.compile(r"[A-Za-z0-9 ()'.,-]+")
MAX_PAGES = 59
PAGE_NAME = re.compile(r"[a-z]+\.smd")
FRONT_LINE = re.compile(r"\.(title|description|date|layout) = [^\n]+,")
FRONT_KEYS = ["title", "description", "date", "layout"]
NEXT_PHASE = {
    None: {"Given": "given"},
    "given": {"Given": "given", "And": "given", "When": "when"},
    "when": {"When": "when", "And": "when", "Then": "then"},
    "then": {"Then": "then", "And": "then", "When": "when"},
}
# Each page: its title, description, layout, and the README heading it starts at and the one it ends before.
PAGES = {
    "index.smd": ("overwatch", "Test watchers that hand every failing build to the agent the moment it happens.", "index.shtml", "# overwatch", "## Watchers"),
    "watchers.smd": ("Watchers", "The test runners overwatch finds in a project, and how it reads what they print.", "page.shtml", "## Watchers", "## Per-project override"),
    "configuration.smd": ("Configuration", "Turning overwatch off, or giving a project its own commands, with .overwatch.json.", "page.shtml", "## Per-project override", "## Install"),
    "behavior.smd": ("Behavior", "Executable examples of failure gates, recovery, and inherited-finding policies.", "page.shtml", "# How Overwatch behaves", None),
    "install.smd": ("Install", "Adding overwatch to Claude Code, Codex, OpenCode, Pi, or Neovim.", "page.shtml", "## Install", "## Neovim"),
    "neovim.smd": ("Neovim", "The same watchers beside the editor, with no agent involved.", "page.shtml", "## Neovim", "## Develop"),
    "develop.smd": ("Develop", "Running overwatch's own tests and trying a local checkout.", "page.shtml", "## Develop", None),
}


class SyncError(Exception):
    """README.md or docs/behavior.md is not in the shape the site needs; the message says what to change there."""


def section(readme: list[str], start: str, end: str | None) -> list[str]:
    """The README's lines after the heading start, up to the heading end or the end of the file, with its
    subheadings moved up to start at level 1, as SuperMD documents do."""
    depth = len(start.partition(" ")[0])
    first, last = bounds(readme, start, end)
    body, fenced = [], False
    for line in readme[first + 1 : last]:
        fenced ^= line.startswith("```")
        body.append(heading(line[depth:]) if line.startswith("#") and not fenced else line)
    html = [line for line in body if line.startswith("<")]
    if fenced:
        raise SyncError(f"the '{start}' section leaves a code fence open; close it with ```")
    if html or not any(line.strip() for line in body):
        raise SyncError(f"the '{start}' section is empty or has raw HTML {html[:2]}, which SuperMD cannot show; fix it")
    assert len(body) == last - first - 1, f"'{start}' gave {len(body)} lines from {last - first - 1}; keep one output line per input line"
    assert all("\n" not in line for line in body), f"a line of '{start}' gained a line break; heading() must return one line"
    return body


def bounds(readme: list[str], start: str, end: str | None) -> tuple[int, int]:
    """The index of the start heading and of the end heading, or the length of readme when end is None.

    Raises SyncError when either heading is missing or end does not come after start."""
    missing = [mark for mark in (start, end) if mark is not None and mark not in readme]
    if missing:
        raise SyncError(f"headings {missing} are missing; add them or update PAGES in docs/sync.py")
    first = readme.index(start)
    last = len(readme) if end is None else readme.index(end)
    if first >= last:
        raise SyncError(f"'{end}' comes before '{start}'; keep the sections in order")
    assert 0 <= first < last <= len(readme), f"section bounds {first}..{last} fall outside {len(readme)} lines; check the index lookups"
    assert readme[first] == start, f"line {first} is {readme[first]!r}, not the start heading {start!r}"
    return first, last


def heading(line: str) -> str:
    """A heading with the id GitHub gives it, so links to the README's sections work on the site too."""
    hashes, _, title = unicodedata.normalize("NFKC", line).partition(" ")
    slug = re.sub(r"[^a-z0-9 -]", "", title.lower()).replace(" ", "-")
    if set(hashes) != {"#"} or not slug or not TITLE.fullmatch(title):
        raise SyncError(f"heading {line!r} needs # marks and a title of letters, digits, spaces and -()'.,; reword it")
    linked = f"{hashes} [{title}]($heading.id('{slug}'))"
    assert re.fullmatch(r"[a-z0-9-]+", slug), f"slug {slug!r} for {title!r} has characters an id cannot hold; tighten the slug pattern"
    assert linked.startswith(f"{hashes} ["), f"heading {line!r} became {linked!r}, losing its level"
    return linked


def mark_step(line: str, phase: str | None) -> tuple[str, str | None]:
    """Marks a guide step line with its phase, given the phase of the step before it in the same scenario; other
    lines pass through. Raises SyncError for a step line that does not parse or a keyword out of Given, When, Then order."""
    if not line.startswith("- **"):
        return line, phase
    keyword = re.match(r"- \*\*(\w+)\*\* ", line)
    if keyword is None:
        raise SyncError(f"docs/behavior.md has step line {line!r} without a bold keyword; regenerate it with python3 scripts/scenarios.py")
    word = keyword[1]
    following = NEXT_PHASE[phase].get(word)
    if following is None:
        raise SyncError(f"docs/behavior.md has {word!r} after phase {phase!r}; regenerate it with python3 scripts/scenarios.py")
    marked = f"- [{word}]($text.attrs('{following}')) {line[keyword.end():]}"
    assert following in NEXT_PHASE, f"{word!r} led to unknown phase {following!r}; fix NEXT_PHASE"
    assert marked.endswith(line[keyword.end():]), f"marking {line!r} lost the step's text"
    return marked, following


def scenarios(body: list[str]) -> list[str]:
    """The behavior guide with every heading starting a section, each scenario's marked verified or proposed, its
    tags as chips, and each step's keyword marked with its phase, so the site can style and search them.

    Each scenario heading starts a new Given, When, Then sequence. Raises SyncError, saying to regenerate the guide,
    when a step line, keyword order or tags line is malformed."""
    status, phase, marked = "verified", None, []
    for line in body:
        if line.startswith("### "):
            phase = None
        line, phase = mark_step(line, phase)
        if line.startswith("# "):
            status = "proposed" if line.startswith("# [Proposed") else "verified"
        if line.startswith("#"):
            attrs = f".attrs('{status}')" if line.startswith("### ") else ""
            line = re.sub(r"\$heading\.id\('([^']*)'\)\)$", rf"$section.id('\1'){attrs})", line)
        if line.startswith("Tags: "):
            if not line.endswith("."):
                raise SyncError(f"docs/behavior.md has tags line {line!r} without its closing period; regenerate it with python3 scripts/scenarios.py")
            line = " ".join(f"[{tag}]($text.attrs('tag'))" for tag in line.removeprefix("Tags: ").rstrip(".").split(", "))
        marked.append(line)
    assert len(marked) == len(body), f"marking turned {len(body)} guide lines into {len(marked)}; keep one per line"
    assert phase in NEXT_PHASE, f"the guide's steps ended in phase {phase!r}; only those in NEXT_PHASE exist"
    return marked


def page(metadata: tuple[str, str, str], body: list[str], order: int, count: int) -> str:
    """A SuperMD page: frontmatter with its title, description and layout, then body. The site lists pages newest
    first, so page order of count is dated count - order seconds after midnight on DATE: the first page is newest."""
    if not all(isinstance(value, str) and value for value in metadata):
        raise SyncError(f"page metadata {metadata} needs a non-empty title, description and layout string; fix it in PAGES")
    title, description, layout = (json.dumps(value, ensure_ascii=False) for value in metadata)
    front = ["---", f".title = {title},", f".description = {description},", f'.date = .date("{DATE}T00:00:{count - order:02}"),', f".layout = {layout},", "---", ""]
    text = "\n".join(front + body).rstrip() + "\n"
    assert text.startswith("---\n") and text.count("\n---\n") >= 1, f"page {title} lost its frontmatter fences; check front"
    assert len(text.split("\n---\n", 1)[0].splitlines()) == len(front) - 2, f"page {title}'s frontmatter spans extra lines; a value broke out of its quotes"
    return text


def render_pages(pages: dict[str, tuple[str, str, str, str, str | None]], readme: list[str], guide: list[str]) -> dict[str, str]:
    """Every page's text by file name, built from the README and the behavior guide before anything is written.

    Raises SyncError when the README lacks its title, there are more pages than seconds to date them by, or a page's
    start and end headings are the same."""
    count = len(pages)
    if not readme or readme[0] != "# overwatch":
        raise SyncError("README.md must start with its '# overwatch' title; put it back on the first line")
    if not 0 < count <= MAX_PAGES:
        raise SyncError(f"{count} pages cannot be dated by seconds; keep PAGES between 1 and {MAX_PAGES}")
    misnamed = [name for name in pages if not PAGE_NAME.fullmatch(name)]
    if misnamed:
        raise SyncError(f"page names {misnamed} must be lowercase letters ending in .smd; rename them in PAGES")
    same = [name for name, (_, _, _, start, end) in pages.items() if start == end]
    if same:
        raise SyncError(f"pages {same} start and end at the same heading; give each a later end in PAGES")
    rendered = {}
    for order, (name, (title, description, layout, start, end)) in enumerate(pages.items()):
        body = section(guide, start, end) if name == "behavior.smd" else section(readme, start, end)
        rendered[name] = page((title, description, layout), scenarios(body) if name == "behavior.smd" else body, order, count)
    assert rendered.keys() == pages.keys(), f"rendered {sorted(rendered)} for pages {sorted(pages)}; render each page once"
    assert all(text.endswith("\n") for text in rendered.values()), "a rendered page lacks its final newline; page() must add it"
    return rendered


def front_keys(text: str) -> list[str | None]:
    """The key of each line of text's opening frontmatter block, None for a line that is not one key line as page()
    writes them, or an empty list when text does not open with a fenced block."""
    lines = text.split("\n")
    if lines[0] != "---" or "---" not in lines[1:]:
        return []
    block = lines[1 : lines.index("---", 1)]
    keys = [match[1] if (match := FRONT_LINE.fullmatch(line)) else None for line in block]
    assert len(keys) == len(block), f"{len(keys)} keys for {len(block)} frontmatter lines; report one per line"
    assert set(keys) <= {*FRONT_KEYS, None}, f"keys {keys} include ones FRONT_LINE should not match; keep it to {FRONT_KEYS}"
    return keys


def replace_page(target: Path, text: str) -> str:
    """Replaces target with text through one open handle and returns what it held before: it is read, confirmed to
    be empty or a page this script generated, then truncated and written. Raises SyncError when it was not generated here."""
    with target.open("a+") as page:
        fcntl.flock(page, fcntl.LOCK_EX)
        page.seek(0)
        previous = page.read()
        if previous and front_keys(previous) != FRONT_KEYS:
            raise SyncError(f"{target} was not generated by docs/sync.py; move it aside and rerun")
        page.seek(0)
        page.truncate()
        page.write(text)
        page.flush()
        page.seek(0)
        written = page.read()
    assert written == text, f"{target} holds {len(written)} characters after writing {len(text)}; rerun python3 docs/sync.py --write"
    assert front_keys(written) == FRONT_KEYS, f"{target} was written with frontmatter keys {front_keys(written)}; page() must write {FRONT_KEYS}"
    return previous


def write_pages(directory: Path, texts: dict[str, str], confirmed: frozenset[str]) -> None:
    """Replaces each named page of directory with its text, all or none, but only the pages named in confirmed, the
    list the person running the script asked to rewrite; when one fails, the pages already replaced get their previous
    text back. Raises SyncError for a page that was not confirmed, a file in the way that this script did not
    generate, or a page that could not be written."""
    unconfirmed = sorted(texts.keys() - confirmed)
    misnamed = [name for name in texts if not PAGE_NAME.fullmatch(name)]
    if misnamed:
        raise SyncError(f"page names {misnamed} must be lowercase letters ending in .smd; rename them in PAGES")
    if unconfirmed:
        raise SyncError(f"pages {unconfirmed} were not among those listed for rewriting {sorted(confirmed)}; rerun python3 docs/sync.py --write")
    targets = {directory / name: text for name, text in texts.items()}
    previous: dict[Path, str] = {}
    try:
        for target, text in targets.items():
            previous[target] = replace_page(target, text)
    except (OSError, SyncError) as error:
        for target, text in previous.items():
            target.write_text(text)
        raise SyncError(f"no pages changed, since one could not be replaced: {error}; fix it and rerun python3 docs/sync.py --write") from error
    assert previous.keys() == targets.keys(), f"replaced {len(previous)} of {len(targets)} pages; every page must be replaced"
    assert {target.name for target in targets} <= confirmed, f"replaced {sorted(targets)} beyond the confirmed {sorted(confirmed)}"


def stale_pages(directory: Path, rendered: dict[str, str]) -> dict[str, str]:
    """The rendered pages whose file in directory is missing or holds different text, by name. Raises SyncError for a
    name that is not a page file name."""
    misnamed = [name for name in rendered if not PAGE_NAME.fullmatch(name)]
    if misnamed:
        raise SyncError(f"page names {misnamed} must be lowercase letters ending in .smd; rename them in PAGES")
    stale = {name: text for name, text in rendered.items() if not (directory / name).exists() or (directory / name).read_text() != text}
    assert stale.keys() <= rendered.keys(), f"stale pages {sorted(stale)} are not all among rendered {sorted(rendered)}"
    assert all(stale[name] == rendered[name] for name in stale), f"stale pages {[name for name in stale if stale[name] != rendered[name]]} differ from their rendering"
    return stale


def main(pages: dict[str, tuple[str, str, str, str, str | None]], repo: Path, write: bool) -> int:
    """Renders all site pages from repo's README and behavior guide and lists those out of date in docs/content.
    Without write that is all it does, returning 1 when any are out of date; with write, the explicit confirmation,
    it rewrites exactly the pages it listed."""
    docs = repo / "docs"
    try:
        readme, guide = (repo / "README.md").read_text().splitlines(), (docs / "behavior.md").read_text().splitlines()
    except OSError as error:
        raise SyncError(f"could not read {error.filename}: {error.strerror}; run from a full checkout") from error
    rendered = render_pages(pages, readme, guide)
    content = docs / "content"
    assert len(rendered) == len(pages), f"rendered {len(rendered)} of {len(pages)} pages; render_pages must return every page"
    stale = stale_pages(content, rendered)
    for name in stale:
        print(f"{content / name} {'rewritten' if write else 'is out of date'}")
    if write:
        write_pages(content, stale, frozenset(stale))
    status = 1 if stale and not write else 0
    assert status in (0, 1), f"status {status} is not an exit status; return 0 or 1"
    return status


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write", action="store_true", help="Rewrite the out of date pages it lists")
    try:
        raise SystemExit(main(PAGES, REPO, parser.parse_args().write))
    except SyncError as error:
        print(f"docs/sync.py: {error}", file=sys.stderr)
        raise SystemExit(1)
