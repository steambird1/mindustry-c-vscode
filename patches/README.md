# Patches to the Mindustry-C compiler

Each file here is a self-contained unified diff against the compiler in
`../compiler` (which is its own git repository). They are applied to the
working tree of that repository and are also recorded in
[`../docs/COMPILER-INTEGRATION.md`](../docs/COMPILER-INTEGRATION.md).

| Patch | Target | Summary |
| --- | --- | --- |
| `0001-expose-prepare-and-analyze.patch` | `mindc.js` | Split the front half of `compile()` into `prepare()`; add `analyze()` for diagnostics-only runs. |
| `0002-injectable-include-resolver.patch` | `mindcLexer.js` | Optional `includeResolver` so `#include` can be resolved from disk outside a browser. |

## Applying

```sh
cd compiler
git apply ../patches/0001-expose-prepare-and-analyze.patch
git apply ../patches/0002-injectable-include-resolver.patch
```

`0002` only applies if `0001`'s target lines are intact; they touch different
files, so they are independent.

## Reverting

```sh
cd compiler
git apply -R ../patches/0001-expose-prepare-and-analyze.patch
git apply -R ../patches/0002-injectable-include-resolver.patch
```

The extension still works without them, at reduced quality — the adapter
feature-detects both and falls back (see COMPILER-INTEGRATION.md). Without
`0001`, diagnostics use a full `compile()` and get slow on large files; without
`0002`, `#include` falls back to the extension's own pre-expansion.

## Re-recording a patch after editing the compiler

`scripts/record-compiler-patch.mjs` diffs a "before" and an "after" snapshot of
a single file, so the recorded patch contains only that one edit. The paths
inside the diff are declared with `--paths`, so it applies inside `compiler/`
even though the snapshots live elsewhere:

```sh
node scripts/record-compiler-patch.mjs \
     %TEMP%\prepatch\mindc.js compiler\mindc.js \
     patches/0001-expose-prepare-and-analyze.patch \
     --paths mindc.js
```

Verify it round-trips before committing:

```sh
cd compiler && git apply --check ../patches/0001-expose-prepare-and-analyze.patch
```

## Proving a patch changes no behaviour

A patch that only exists to expose an API must not change what the compiler
produces. That is checked mechanically rather than by reading the diff:

```sh
npm run patches:verify
```

This compiles every file in `compiler/testers/` twice — once with the patches
applied, once with them reverted — and compares the generated code, the
diagnostics and the warnings byte for byte. It is part of `npm run check`.

