# Compiler integration

The extension does **not** link against the compiler's internals. Everything it
needs goes through one adapter, [`src/compiler/bridge.ts`](../src/compiler/bridge.ts),
and the adapter only uses symbols the compiler actually exports today. The
compiler is young and its internals move around, so the rule is:

> If a fact about the compiler is not exported, either feature-detect it at
> runtime or patch the compiler — and write the patch down.

This file is the record. It lists the public surface the extension relies on,
the two patches applied on top, and what the adapter does when a patch is
missing (they are all optional at runtime).

## Patches

| Patch | File | Adds | Why |
| --- | --- | --- | --- |
| `0001-expose-prepare-and-analyze.patch` | `mindc.js` | `Compiler#prepare()`, `Compiler#analyze()` | The only fast way to get diagnostics. A full `compile()` runs the optimiser, whose fixed-point loop costs **36 s on a ~100 KB file**; `analyze()` stops after semantic analysis (≈130 ms on the same file). |
| `0002-injectable-include-resolver.patch` | `mindcLexer.js` | `new Lexer(src, macros, suppress, params, { includeResolver, filename })` | `handleInclude()` is hardcoded to `fetch('/include/…')` / `import('/include/…')`, which only works behind the dev web server. The resolver lets the extension read includes from disk and hands back the include graph. |

Apply or revert them from a checkout of the compiler repository:

```sh
cd compiler
git apply ../patches/0001-expose-prepare-and-analyze.patch
git apply ../patches/0002-injectable-include-resolver.patch

git apply -R ../patches/0001-expose-prepare-and-analyze.patch   # revert
```

`0001` is verified behaviour-neutral: with it applied, all 80 files in
`compiler/testers/*.c` produce byte-identical output, diagnostics and warnings
(see `npm run test:golden` in this repository, which pins the hashes).

### 0001 in detail

`compile()` was one long method: tokenise → read pragmas → build the phase
config → rebuild the phases → parse → analyse → optimise → generate. The patch
lifts the first four steps into `prepare()` verbatim (same indentation, no
reformatting, so the diff stays reviewable) and adds `analyze()`, which is
`prepare()` + parse + analyse and returns the **analysed AST** or `null` when
there are errors. `compile()` now begins with `await this.prepare();` and is
otherwise untouched.

### 0002 in detail

`Lexer` takes an optional fifth argument. When `includeResolver` is a function,
`handleInclude()` delegates to it and never touches `fetch`; the resolver
returns either `{ text, path }` (a source file, tokenised recursively with the
same resolver and the child's own `filename`) or `{ extension }` (a `.js`
compiler extension that the host already loaded). With no resolver the old HTTP
path is used unchanged, so `main.html` keeps working.

Tokens coming from an include carry `location.filename`, which is what lets the
extension report diagnostics against the right file instead of against the
includer.

## Public surface the extension uses

```js
import { Compiler }              from './mindc.js';            // compile(), prepare(), analyze()
import { MemoryBlock }           from './mindcGeneratorBase.js' // new MemoryBlock(name, size)
import { AttributeClass }        from './mindcBase.js';         // config.get/setAttribute
import { Lexer, KEYWORDS, SPECIAL_INSTRUCTIONS, OPERATORS, PUNCTUATORS }
                                  from './mindcLexer.js';       // grammar + completion data
import { CONTENT_ORDER, DEFAULT_CONTENT_IDS, DEFAULT_CONTENT_NAMES }
                                  from './mindcContent.js';     // @constant completion + colours
```

Result shapes the adapter relies on:

| Value | Shape |
| --- | --- |
| `compile()` | `{ success, code, errors, warnings, fatalError? }` |
| `analyze()` | `{ ast \| null, errors, warnings, fatalError? }` |
| a diagnostic | `{ message, line, column }` — 1-based, `line`/`column` may be absent |
| a token | `{ type, value, raw, location: { line, column, index, filename? } }` |
| `AttributeClass` | `getAttribute(k)`, `setAttribute(k, v)`, `hasAttribute(k)` |

## Reading the analyser without depending on it

Language features (hover, go-to-definition, references, rename, completion) do
not need a compiler change. After `analyze()`, `SemanticAnalyzer` has already
linked **every** AST node to a `Scope` and resolved every named node:

```js
const entry = node.scope.lookup(node.name);   // SymbolEntry | null
entry.kind            // 'variable' | 'function' | 'parameter' | 'type'
entry.type            // TypeInfo (or a function signature object)
entry.location        // { line, column, index } of the declaration
```

Verified on `compiler/testers/sample1.c`: 24 named nodes, 24 resolvable, 0
unresolved. The adapter walks the AST once per analysis and materialises a flat
`SymbolIndex` (see `src/compiler/symbols.ts`) so the server never touches a
`Scope` object directly — if the compiler renames those fields, only the index
builder changes.

`compiler/AnalysisWorker` snapshots the compiler on every request, so an
analyser crash can only ever affect the worker; the supervisor respawns it and
the user sees one "internal error" diagnostic instead of a frozen editor.

## Build-time extraction

`npm run gen` reads the compiler directly (no bundling needed) and writes:

- `syntaxes/mlgc.tmLanguage.json` — keyword, instruction, operator and
  `@content` rules generated from `KEYWORDS`, `SPECIAL_INSTRUCTIONS`,
  `OPERATORS`, `PUNCTUATORS`, `CONTENT_ORDER` and `DEFAULT_CONTENT_IDS`;
- `src/compiler/generated/tables.json` — the same tables in a shape the
  extension can import.

The compiler stays the single source of truth for its vocabulary: a new content
id shows up in the grammar after `npm run gen` with no hand-editing.
