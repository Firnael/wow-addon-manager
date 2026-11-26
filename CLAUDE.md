# CLAUDE.md (wam)

## Same on every OS, as light as possible

wam runs on macOS, Windows and Linux, and is installed with `npm install -g <tarball URL>` (see README).

- No system tools and no native npm packages. Pure-JS dependencies only, and only when Node can't do it (today: `pngjs`, `jpeg-js` for logos). Zips are extracted by `src/zip.mjs` (zlib), not `unzip`.
- Whatever differs between OSes (opening a URL, folder links = junctions on Windows, default AddOns folder, system certificates) lives in `src/platform.mjs` only.
- Paths through `node:path` (`join`, `basename`), never split on `/`.
- `bin/wam.mjs` is only the Node ≥ 24 guard: it must stay parseable by old Node, so no static imports there. The CLI is `src/cli.mjs`.
- The TUI is hand-written on purpose (no Ink or other TUI lib): it starts instantly and draws logos as one ANSI string per line.

## Testing

- Never on the real AddOns folder for installs: `WAM_HOME=<scratch dir>` with a `config.json` whose `addonsDir` points into the scratch dir (copy `~/.config/wam/catalog.json` there when deps need the catalog).
- `wam check` on the real folder is read-only and fine to run.
- To test the npm install, run the real command without `--prefix`, then `npm uninstall -g wow-addon-manager`. With `--prefix`, Volta prints "Could not determine the name of the package" although the install worked: a false alarm.

## Docs

README and user-facing messages in French; code comments in English.
