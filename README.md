# mend

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/whyuardi/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/whyuardi/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree of files.
`SPEC.md` is the whole specification. Built for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
("Build mend", $100, top 10).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or `-`,
  the patch is read from standard input. The working directory is the root of the tree.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`,
  the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## The four formats

- **Unified diffs** — sections with `diff --git` / `---` / `+++` headers and `@@` hunks, including
  creations, deletions and renames. Hunk line numbers are only a hint: each hunk takes the occurrence
  nearest to its stated position.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines, `=======`, new lines,
  `>>>>>>> REPLACE`. Empty old lines create the file.
- **V4A patches** — `*** Begin Patch` / `*** End Patch` with `*** Add File:`, `*** Delete File:` and
  `*** Update File:` sections, `@@` anchors, `*** Move to:` and `*** End of File` chunks.
- **JSON edits** — one JSON array of edit objects, or JSON Lines: `create`, `str_replace` and `insert`.

## Matching

An edit names old lines O that are replaced by new lines N. O is found at the first of three tiers at
which it occurs: exact lines (tier 0), lines equal once trailing spaces and tabs are removed (tier 1),
or lines equal once leading and trailing spaces and tabs are removed (tier 2). At tier 2 the new lines
are re-indented to the file's own indentation, and context lines are always written as the file's own
matched lines, never the patch's. `--strict` tries tier 0 only.

Every file is changed or none: edits apply in the patch's order, a failed edit changes nothing, the
edits after it still run, and when any edit failed no file is written. Exit 0 prints one line per
changed path (`A`, `D`, `M`, or `R old -> new` for a move) and `ok: <n> files`; exit 1 lists each
failed edit and `failed: <k> of <n> edits`; exit 2 is a usage, missing-patch, format or parse error.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to
  `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: the trial runner, kept as the kit has it. It reads the checks from the env, runs
  `node main.ts` on each one in a fresh directory, and posts the exit code, stdout and files left.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check `main.ts` gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## Practice score

100 of 100 practice checks pass (unified 30/30, search_replace 20/20, v4a 20/20, json 15/15,
cli 15/15), plus an edge-case battery covering CRLF files, files without a final line break,
`\ No newline at end of file`, empty insertions, ambiguous occurrences, `--check`, `--strict`, usage
errors, unsafe paths, atomicity, moves and renames, V4A anchors and end-of-file chunks, and JSON
insert bounds.
