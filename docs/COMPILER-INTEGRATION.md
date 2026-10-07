# Compiler integration

The extension does **not** link against the compiler's internals. Everything it
needs goes through one adapter, [`src/compiler/bridge.ts`](../src/compiler/bridge.ts),
and the adapter only uses symbols the compiler actually exports today. The
compiler is young and its internals move around, so the rule is:

> If a fact about the compiler is not exported, either feature-detect it at
> runtime or patch the compiler — and write the patch down.

This file is the record. It lists the public surface the extension relies on,
the two patches applied on top, the AST quirks that had to be bridged, and what
the adapter does when a patch is missing (they are all optional at runtime).

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

Both are verified **behaviour-neutral**: with them applied, every file in
`compiler/testers/*.c` produces byte-identical output, diagnostics and warnings
compared to a compiler with them reverted. `npm run patches:verify` proves that
on each run rather than trusting a review of the diff, and
`npm run test:golden` pins the fingerprints.

### 0001 in detail

`compile()` was one long method: tokenise → read pragmas → build the phase
config → rebuild the phases → parse → analyse → optimise → generate. The patch
lifts the first four steps into `prepare()` verbatim (same indentation, no
reformatting, so the diff stays reviewable) and adds `analyze()`, which is
`prepare()` + parse + analyse and returns the **analysed AST** or `null` when
there are errors. `compile()` now begins with `await this.prepare();` and is
otherwise untouched.

`analyze()` deliberately returns the AST even when `ok` is false: a user is
mid-edit most of the time, and a broken file still has to offer completion and
go-to-definition.

### 0002 in detail

`Lexer` takes an optional fifth argument. When `includeResolver` is a function,
`handleInclude()` delegates to it and never touches `fetch`; the resolver
returns either `{ text, path }` (a source file, tokenised recursively with the
same resolver and the child's own `filename`) or `{ extension }` (a `.js`
compiler extension that the host already loaded). With no resolver the old HTTP
path is used unchanged, so `main.html` keeps working.

Tokens coming from an include carry `location.filename`, which is what lets the
extension follow includes at all.

## Public surface the extension uses

```js
import { Compiler }              from './mindc.js';             // compile(), prepare(), analyze()
import { MemoryBlock }           from './mindcGeneratorBase.js' // new MemoryBlock(name, size)
import { AttributeClass }        from './mindcBase.js';         // config.get/setAttribute
import { Lexer, TokenType, KEYWORDS, SPECIAL_INSTRUCTIONS, OPERATORS, PUNCTUATORS }
                                  from './mindcLexer.js';       // grammar + completion data
import { CONTENT_ORDER, DEFAULT_CONTENT_IDS, DEFAULT_CONTENT_NAMES }
                                  from './mindcContent.js';     // @constant completion + colours
```

Result shapes the adapter relies on:

| Value | Shape |
| --- | --- |
| `compile()` | `{ success, code, errors, warnings, fatalError? }` |
| `analyze()` | `{ ast \| null, ok, errors, warnings, fatalError? }` |
| a diagnostic | `{ message, line, column }` — 1-based, `line`/`column` may be absent |
| a token | `{ type, value, raw, location: { line, column, index, filename? } }` |
| `AttributeClass` | `getAttribute(k)`, `setAttribute(k, v)`, `hasAttribute(k)` |

## How the compiler is loaded

The compiler is ESM spread over a dozen files with no `package.json` of its own,
so nothing can `import` it directly. `scripts/build.mjs` bundles it with esbuild
into **`out/compiler/mindc.cjs`**, built from a synthetic entry that re-exports
exactly the names the extension uses:

| From | Re-exported |
| --- | --- |
| `mindc.js` | `Compiler`, `CompilerExtensionBase`, `defaultExtensions` |
| `mindcBase.js` | `AttributeClass`, `ASTNodeType` |
| `mindcGeneratorBase.js` | `MemoryBlock`, `MEMORY_RESERVE_SIZE` |
| `mindcLexer.js` | `Lexer`, `TokenType` |

That list is a **contract**. A compiler refactor that renames or drops one of
those exports fails the build of `out/compiler/mindc.cjs` with a named error,
instead of shipping an extension that throws at runtime. Adding a compiler name
means touching exactly two things: that entry, and `CompilerModule` in
`src/compiler/bridge.ts`.

Build scripts and the test runner cannot go through the bundle — it is built out
of the sources they are about to test — so `scripts/lib/load-compiler.mjs`
bundles the compiler to a temporary ESM file, imports it, and deletes it.

## Reading the analyser without depending on it

Language features (hover, go-to-definition, references, rename, completion and
the outline) need no compiler change. After `analyze()`, `SemanticAnalyzer` has
already linked every AST node to a `Scope` and resolved every named node:

```js
const entry = node.scope.lookup(node.name);   // SymbolEntry | null
entry.kind            // 'variable' | 'function' | 'parameter' | 'type'
entry.type            // TypeInfo (or a function signature object)
entry.location        // { line, column, index } of the declaration
```

`src/compiler/symbols.ts` walks the analysed AST once per run and materialises
plain data (`DocumentIndex`), so the server never touches a `Scope` object
directly. If the compiler renames those fields, only that one file changes.

### The AST is not shaped the way an editor wants it

Every row below is a verified property of the compiler's AST, not a guess. Each
one is bridged in `symbols.ts` rather than patched into the compiler, because a
patch costs a review and a rebasing every time the compiler moves. If the
compiler changes one of these, this is the list to re-check.

| What the AST does | Why it is surprising | How it is handled |
| --- | --- | --- |
| A declaration's `location` is the **start of the statement** | `int total(int a)` reports the position of `int`, and a function's `SymbolEntry.location` does the same, so go-to-definition would land on the return type | The name is recovered from the source: for a function, the identifier in front of the parameter list's `(`; otherwise the first whole-word match after the reported position |
| A struct definition's `type` is the bare string `'struct'` / `'union'` | The parser overwrites the node's type with the keyword | `typeDefinitions` is read up front by a dedicated pass, and the generic walk skips it |
| A struct's name is on `name`, not `typeName` | Every *other* node that names a type puts it in `typeName`, so a generic "this node declares a type" rule fires on **every return type** and invents a type called `int` | Only `typeDefinitions` declares types |
| A struct's members are untyped nodes whose `type` is a `TypeSpecifier` **object** | `node.type` is not a string, so any code that reads it as one gets `''` | Members are read from the struct definition, preferring the analyser-resolved member type |
| A `MemberExpression`'s member identifier has `location: null`, no symbol and no `dataType` | The parser does not carry the token into the node at all | The position comes from a bounded scan of the text after the object; the type and declaration come from the struct the object resolved to |
| A pointer's `members` is `[]`, with the real members on `pointerTo` | Reading `.members` alone silently loses every member of a struct reached through a pointer or an array | Types are unwrapped through `pointerTo` before members are read |
| The second and later overloads of a function are renamed `name__ov1` | The user never wrote that, and it must never reach completion or rename | Indexed under the source name, one entry per declaration, each with its own signature |
| A parameter node has a `name` and a `location` but **no `symbol`** | Only the function's `Scope` can resolve it | The walk threads the nearest enclosing `Scope` down and resolves untyped named nodes through it |
| Every node's `symbol` field is a flat `SymbolEntry` carrying the **same** name and location as the node it was resolved from | A walk that descends into it declares every parameter and variable a second time | `symbol` is never descended into |

`DocumentIndex` carries one piece of information the compiler does not have: a
field records the struct that declares it (`SymbolInfo.container`). Without it,
the only way to say that `p.x` is a field of `point` — or to offer `point`'s
members after `p.` — is to read the text in front of the dot.

### Checking these claims against the compiler

Every row in that table came from running the compiler, not from reading it. The
tool for doing that again is `scripts/probe.mjs`, which bundles one `.mts` file
with esbuild — TypeScript types and all — and runs it, so a probe can import the
extension's own modules instead of re-deriving them:

```sh
node scripts/probe.mjs probe.mts
```

`probe.mts` is a scratch file and is not committed. A minimal one:

```ts
import { inspect } from 'node:util';
import { analyze, makeMemoryBlocks } from './src/compiler/bridge';

const run = await analyze({
	source: 'struct point { int x; }; int main() { point p; p.x = 1; return 0; }',
	target: {
		targetVersion: 154.3,
		memoryBlocks: makeMemoryBlocks([{ name: 'cell1', size: 64 }]),
		includePaths: [],
	},
	filePath: '/project/main.mlgc',
	readFile: () => null,
});
console.log(
	inspect(run.ast, {
		depth: 12,
		// `parent` closes the tree into a cycle, so `JSON.stringify` throws on
		// it, and `scope` is a live object with methods on it. Neither is worth
		// printing. Drop `depth` to a couple of levels to find one field first.
		filter: key => key !== 'parent' && key !== 'scope',
	})
);
```

When a probe turns a surprise into something the extension handles on purpose,
it is worth keeping as a test in `test/index.test.ts` — the AST facts above are
asserted there, so a compiler refactor that changes one fails the test suite
instead of quietly breaking a feature.

### Pre-existing compiler bugs found along the way

These are the compiler's, not the extension's, and none is worked around
silently:

- **Calling a 3-argument overload when a 2-argument one exists used to crash the
  semantic analyser.** `visitFunctionCall` read a property of `undefined`.
  Patch 0001's `try` caught it, so the run came back `ast: null` with an
  *empty* error list — a file with a mistake in it looked perfectly clean.
  **Fixed in the compiler** by narrowing the overload set on argument count
  before the arguments are visited, plus a bounds guard on the parameter list
  (`preselectOverloadByArity` in `mindcSemantic.js`). The first guard alone was
  not enough: a call matching *no* arity still ran the type-check loop past the
  end of the list, which is the same read from the same method. Both loops are
  guarded now, and `test/index.test.ts` calls both arities — and an arity that
  matches nothing — so a reintroduction fails there rather than in the editor.
- **A typedef's name is not in the program scope.** `scope.lookup('point_t')`
  returns `null` even though `point_t` resolves everywhere else, so a typedef's
  type is read out of the text between the `typedef` keyword and the name.
- **The dialect has no `enum`.** `enum colour { red, green };` is a parse error
  (`Expected variable name in declaration`).
- **A `for` initialiser must be an expression, not a declaration.**
  `for (int i = 0; i < 3; i++)` reports `Unexpected token in expression: INT
  'int'`, then an internal parser error and five cascading diagnostics;
  `for (; t < 3; t++)` fails too, because the parser expects an expression
  first either way. Checked against `HEAD` with the patches applied and the
  behaviour is identical, so this is the compiler's and not something this
  repository introduced. The extension shows whatever the parser produced,
  internal error included.
- **`@`-constants parse as identifiers named after the sigil** (`@copper`), with
  no symbol. They are left out of the index — indexing them unresolved would
  make hover claim a perfectly valid content id is undeclared — and answered from
  the generated tables instead.
- **esbuild warns about the compiler's own source**: a duplicate key
  `POINTER_TYPE` in `mindcBase.js`, a duplicate `REMOTE` in `mindcLexer.js`, a
  duplicate member `raw_replace` in `mindcInstruction.js`, and a duplicate
  `AssignmentExpression` case in `mindcOptimizer.js`. `scripts/build.mjs`
  collapses these into one `note:` line so they do not drown out our own
  warnings.

### Known limitation: which file a diagnostic belongs to

A diagnostic's `line`/`column` is relative to the file the error was raised in,
but the diagnostic does not say which file that is — only tokens carry
`location.filename`. `src/compiler/diagnostics.ts` therefore attributes a
diagnostic by matching its line and column against the token stream, which is
exact when the error is on a token and approximate otherwise. An error inside a
header can end up reported against the `#include` line of the including file.
Doing this properly means the compiler putting the file on the diagnostic, which
would be a third patch; it is worth doing if diagnostic attribution in headers
becomes a problem.

## Crash containment

The analysis worker snapshots the compiler on every request, so an analyser
crash can only ever affect the worker; the supervisor respawns it. Builds run in
a separate, cancellable worker, and exactly one build runs at a time.

What the user sees when a run dies is less obvious than it looks, because a
crash is not an error: patch 0001 catches it and returns a run with
`fatalError` set, no AST, and often no diagnostics at all. Left alone, that run
would *clear* the previous one's squiggles, and a file with a mistake in it
would read as clean. So the server treats a dead run as a finding of its own —
one diagnostic at the top of the file, saying the file has not been checked —
with the full stack in the `Mindustry-C` output channel, where all of it fits.

Three ways a run dies, all reaching the server as `fatal`:

| Where it died | `fatal` | `index` |
| --- | --- | --- |
| The compiler throws inside `analyze()` (caught by patch 0001) | full stack | present, `internalError` = first line |
| The worker throws around the compiler | full stack | `null` |
| The worker thread dies (supervisor `fail()`) | message | `null`, already carrying its own diagnostic |

The server reads `response.fatal ?? response.index?.internalError` and does not
add a second diagnostic when the one already present says the same thing, so a
dead thread still produces exactly one message. `test/analysis.test.ts` pins
both spellings: if either stops being written, the diagnostic that stands in for
a whole run's worth of findings disappears and the file looks clean again.

## Build-time extraction

`npm run gen` reads the compiler directly (no bundling needed) and writes:

- `syntaxes/mlgc.tmLanguage.json` — keyword, instruction, operator and
  `@content` rules generated from `KEYWORDS`, `SPECIAL_INSTRUCTIONS`,
  `OPERATORS`, `PUNCTUATORS`, `CONTENT_ORDER` and `DEFAULT_CONTENT_IDS`;
- `src/compiler/generatedTables.ts` — the same tables in a shape the extension
  can import.

`npm run gen:check` fails if either is stale, so the grammar in the repository
always matches the compiler it ships with. The compiler stays the single source
of truth for its vocabulary: a new content id shows up in the grammar after
`npm run gen` with no hand-editing.
