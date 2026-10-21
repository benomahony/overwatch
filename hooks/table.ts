// Generated from watchers.json by `python3 scripts/table.py`. Edit that file, not this one.
export const TABLE = {
  "watchers": [
    {
      "name": "zig",
      "marker": "build.zig",
      "argv": [
        "zig",
        "build",
        "-Doptimize=fast",
        "test",
        "--watch"
      ],
      "summary": "^Build Summary:.*$",
      "failed": "failed",
      "failure": "^(?:error: '(.+)' failed:|(\\S+\\.zig:\\d+:\\d+: error: .+))$"
    },
    {
      "name": "python",
      "marker": "pyproject.toml",
      "requires": "uv",
      "argv": [
        "uv",
        "run",
        "--with",
        "pytest",
        "--with",
        "pytest-watcher",
        "--with",
        "pytest-testmon",
        "ptw",
        ".",
        "--testmon"
      ],
      "baseline": [
        "uv",
        "run",
        "--with",
        "pytest",
        "--with",
        "pytest-testmon",
        "pytest",
        "--testmon-noselect"
      ],
      "summary": "^=+ .+ in \\d+(?:\\.\\d+)?s(?: \\([^)]*\\))? =+$",
      "failed": "\\b(?:failed|errors?)\\b",
      "failure": "^(?:FAILED|ERROR) (\\S+)"
    },
    {
      "name": "python",
      "marker": "pyproject.toml",
      "requires": "pytest",
      "baseline": [
        "pytest"
      ],
      "summary": "^=+ .+ in \\d+(?:\\.\\d+)?s(?: \\([^)]*\\))? =+$",
      "failed": "\\b(?:failed|errors?)\\b",
      "failure": "^(?:FAILED|ERROR) (\\S+)"
    },
    {
      "name": "vitest",
      "language": "js",
      "marker": "node_modules/.bin/vitest",
      "argv": [
        "npx",
        "--no",
        "--",
        "vitest",
        "watch"
      ],
      "summary": "^ +Test Files +.*$",
      "failed": "\\bfailed\\b",
      "failure": "^ FAIL {2}(\\S+\\.\\w+(?: .*)?)$"
    },
    {
      "name": "jest",
      "language": "js",
      "marker": "node_modules/.bin/jest",
      "argv": [
        "npx",
        "--no",
        "--",
        "jest",
        "--watchAll"
      ],
      "summary": "^Test Suites: .*total$",
      "failed": "\\bfailed\\b",
      "failure": "^(?:FAIL (\\S+)| {2}● (.+))$"
    },
    {
      "name": "bun",
      "language": "js",
      "marker": "bun.lock",
      "argv": [
        "bun",
        "test",
        "--watch"
      ],
      "summary": "^ \\d+ fail$",
      "failed": "^[1-9]\\d* fail$",
      "failure": "^\\(fail\\) (.+?)(?: \\[[0-9.]+m?s\\])?$"
    },
    {
      "name": "bun",
      "language": "js",
      "marker": "bun.lockb",
      "argv": [
        "bun",
        "test",
        "--watch"
      ],
      "summary": "^ \\d+ fail$",
      "failed": "^[1-9]\\d* fail$",
      "failure": "^\\(fail\\) (.+?)(?: \\[[0-9.]+m?s\\])?$"
    },
    {
      "name": "deno",
      "marker": "deno.json",
      "argv": [
        "deno",
        "test",
        "--watch"
      ],
      "summary": "^Watcher \\w+ (?:finished|failed)\\..*$",
      "failed": "failed",
      "result": "^(?:ok|FAILED) \\| .*$",
      "failure": "^(\\S.* => \\S+:\\d+:\\d+)$"
    },
    {
      "name": "deno",
      "marker": "deno.jsonc",
      "argv": [
        "deno",
        "test",
        "--watch"
      ],
      "summary": "^Watcher \\w+ (?:finished|failed)\\..*$",
      "failed": "failed",
      "result": "^(?:ok|FAILED) \\| .*$",
      "failure": "^(\\S.* => \\S+:\\d+:\\d+)$"
    },
    {
      "name": "go",
      "marker": "go.mod",
      "requires": "gotestsum",
      "argv": [
        "gotestsum",
        "--watch"
      ],
      "baseline": [
        "gotestsum",
        "--",
        "./..."
      ],
      "summary": "^DONE \\d+ tests?.*$",
      "failed": "\\b(?:failures?|errors?)\\b",
      "failure": "^(?:\\s*--- FAIL: (\\S+).*|=== FAIL: (.+?)(?: \\([0-9.]+s\\))?|(\\S+\\.go:\\d+:\\d+: .+))$"
    },
    {
      "name": "go",
      "marker": "go.mod",
      "baseline": [
        "go",
        "test",
        "./..."
      ],
      "failure": "^(?:\\s*--- FAIL: (\\S+).*|=== FAIL: (.+?)(?: \\([0-9.]+s\\))?|(\\S+\\.go:\\d+:\\d+: .+))$"
    },
    {
      "name": "rust",
      "marker": "Cargo.toml",
      "baseline": [
        "cargo",
        "test"
      ],
      "failure": "^(?:test (\\S+) \\.\\.\\. FAILED|(error\\[E\\d+\\]: .+))$"
    }
  ],
  "checkers": [
    {
      "name": "zanity",
      "marker": "zanity",
      "argv": [
        "zanity",
        "check",
        ".",
        "--watch",
        "--no-color"
      ],
      "summary": "^zanity: (?:\\d+ errors?(?:,| and) \\d+ warnings? in .*|checked .*, no issues found\\.?)$",
      "failed": "\\b[1-9]\\d* (?:errors?|warnings?)\\b"
    }
  ]
}
