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

### Updating the compiler

`compiler/` is a clone of the compiler repository, and the patches are
working-tree changes, so a compiler update means: fetch, reset, re-apply.

```sh
node scripts/sync-compiler.mjs --dry-run   # fetch, show what is new, change nothing
node scripts/sync-compiler.mjs             # sync + apply every patches/*.patch
node scripts/sync-compiler.mjs --check     # ... and npm run check
node scripts/sync-compiler.mjs --package   # ... check, bump patch, build the vsix
```

The upstream defaults to `../mindustry-c` — the checkout the compiler is
developed in, which is usually ahead of this clone's `origin`, so it is fetched
by path rather than from the remote. Override it with `--upstream <path>` or
`MINDC_UPSTREAM`, and the branch with `--branch`.

The script stops rather than guessing when something needs a judgement:

| Failure | What to do |
| --- | --- |
| a patch no longer applies | the compiler moved the code it touches; re-port the patch and run the script again |
| `gen:check` | the tables changed: `npm run gen`, review the diff, commit it |
| `test` | the AST contract moved: fix `src/compiler/symbols.ts` or `analysis.ts` |
| `test:golden` | the output changed: review the listed files, then `npm run test:golden:update` |
| `patches:verify` | the patches are no longer neutral: re-port them |

Before the reset it saves whatever the checkout had uncommitted to
`out/compiler-wip-<timestamp>.diff`. Normally that is just the patches, which
are reproducible; it matters only if someone hand-edited the compiler there.

`--package --bump none` rebuilds at the current version instead of bumping.

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

The child lexer inherits the parent's options (`...this.lexerOptions`) as well
as the resolver, so an include is read under the same `legacy_char_string` mode
as the file that pulled it in.

Tokens coming from an include carry `location.filename`, which is what lets the
extension follow includes at all.

The text an include resolves to is the editor's buffer when it has that file
open, and the file on disk otherwise. Every open document is handed to the
workers as `uri -> text`; the map is passed at spawn and pushed again whenever
it changes (`KnownDocumentsMessage`), so a header edited but not saved still
resolves, and a thread that has been alive for a while cannot keep reading the
copy it started with. Headers are synced because the extension's document
selector includes `**/*.h` and `**/*.hpp` — VS Code gives them language `c`, so
selecting by `mlgc` alone would never show the server their buffers. The server
never analyses a header; it only reads it.

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

The `Lexer` constructor takes an `options` object (`includeResolver`,
`filename`, `legacyCharString`). The adapter installs the include resolver on the
lexer the `Compiler` constructor already built rather than replacing it: that
lexer holds `__MINDC_TARGET_VERSION__` in its macro table and the
`legacy_char_string` decision. Replacing it silently makes every `#if` over the
target version take the wrong branch, and the bundled `string.h` is gated on
exactly such a test.

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

Language features (hover, go-to-definition, references, rename, completion,
signature help, quick fixes, semantic tokens and the outline) need no compiler
change. After `analyze()`, `SemanticAnalyzer` has already linked every AST node
to a `Scope` and resolved every named node:

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
| A parameter's `type` is a `TypeSpecifier`, and for `struct point` it holds only `struct` | Rendering the specifier gives `struct p`, losing the struct's name; the resolved `dataType` is not attached to parameters | Signature help reads the declared type from the source between the parameter's location and its name; the specifier is only the fallback for an untitled buffer |
| Every node's `symbol` field is a flat `SymbolEntry` carrying the **same** name and location as the node it was resolved from | A walk that descends into it declares every parameter and variable a second time | `symbol` is never descended into |
| A token produced by macro expansion keeps a placeholder location from the definition (often line 1, column 1) | A reference built from it points at `#define` or the first character of the file, and can paint or rename unrelated text | A reference is kept only when the source at its offset actually spells the token's name |

`DocumentIndex` carries one piece of information the compiler does not have: a
field records the struct that declares it (`SymbolInfo.container`). Without it,
the only way to say that `p.x` is a field of `point` — or to offer `point`'s
members after `p.` — is to read the text in front of the dot.

Two more fields are derived rather than resolved: a local's `owner` (the
function that declares it) and a function's `parameters`. Completion uses
`owner` to leave another function's locals out — the index has no block ranges,
so the function is the finest granularity available — and signature help uses
`parameters` for the names, since `type` alone renders `int(int, int)`.

The type pre-pass also keeps a map of named types. A `TypeSpecifier` node has
no symbol and a typedef is not in the program scope, so a `myint` or
`struct point` use is linked back to its declaration through that map; without
it, a custom type only lit up where it was declared.

`#define` is the lexer's business: macros are expanded before parsing, so a use
has no AST node at all. `DocumentIndex.macros` carries the names the lexer
ended up with, and semantic tokens match their occurrences in code (comments and
literals excluded) to paint them. The expansion tokens themselves are not
trustworthy for positions, which is why a reference is guarded by the source
text at its offset.

Semantic tokens are answered from the current index when there is one. When the
analysis is one keystroke behind, the stale index is used: a prefix/suffix diff
of the analysed and current texts maps each recorded position onto the new text.
A token before the change stays put, one after it moves by the net delta, and
only a token the change runs through — whose name may be half rewritten — is
dropped. Each mapped token is then checked against the current text (the name
must sit there as a whole word). That keeps the colours through an edit instead
of clearing the file for the length of the debounce; the dropped tokens come
back via a refresh once the analysis lands. A document with no index at all
(just opened) gets an empty answer and the same refresh — the client asks
immediately on open and does not ask again on its own, so without it a file
keeps its plain TextMate colours until the next edit or theme change.

### String types

`char` and the native Mindustry string are different types, and the editor has
to keep them apart:

- `string_t` is the one-cell machine string. It is **not** a keyword: the parser
  recognises it by name, in the same list as `device` and `content_t`
  (`const specials = [...]`). `npm run gen` reads that list, so the grammar,
  completion and rename protection follow the compiler instead of a hand copy
  (which had already missed `string_t` and the `*_t` content types).
- `char` is an ordinary one-cell number again. `char*` is a real block+offset
  pointer, and only `const char*` may point at a literal: `char *p = "hi"` is
  refused, with a message naming the alternatives. The extension offers a
  `const char*` view, the one-cell `string_t`, or a `char name[]` copy; when
  `<string.h>` is already included and the target is v150 or newer it also
  offers a `string_view` built with `sv_of_string(...)` (a literal does not
  convert to a view on its own).
- A literal materialised for a `const char*` becomes a hidden `__strlit_N`
  declaration in `ast.globalDeclarations`. The index skips it for free: a
  declaration is only recorded when the source text at its location spells its
  name, and the hidden name appears nowhere.
- `#pragma legacy_char_string` makes the lexer read `char` as `string_t` for a
  migration period. The compiler decides this from the source, so the extension
  does nothing; the options are inherited by included headers too.
- `include/string.h` (`string_view`, `sv_at`, `sv_len`, `sv_print`,
  `concat_to_message`, and the C buffer helpers) ships with the compiler.
  `scripts/build.mjs` copies `include/` to `out/include`, and the extension
  appends that directory after the user's `includePaths`, so
  `#include <string.h>` resolves in an installed extension while a project
  header of the same name still wins.

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
  **Fixed upstream in `b3c3a30`**: `preselectOverloadByArity` narrows the
  overload set on argument count before the arguments are visited, and a bounds
  guard covers a call that matches no arity (the first guard alone was not
  enough). This repository carried the same fix in its bundled compiler while
  it was still a local patch; that copy was dropped when the compiler was
  synced. `test/index.test.ts` calls both arities, and an arity that matches
  nothing, so a reintroduction fails there rather than in the editor.
- **A typedef's name is not in the program scope.** `scope.lookup('myint')`
  returns `null` even though `myint` resolves everywhere else, so a typedef's
  type is read out of the text between the `typedef` keyword and the name.
- **The dialect has no `enum`.** `enum colour { red, green };` is a parse error
  (`Expected variable name in declaration`). Still true in the bundled compiler
  (`9e399f4`).
- **`@`-constants parse as identifiers named after the sigil** (`@copper`), with
  no symbol. They are left out of the index — indexing them unresolved would
  make hover claim a perfectly valid content id is undeclared — and answered from
  the generated tables instead.
- **esbuild warns about the compiler's own source**: a duplicate member
  `raw_replace` in `mindcInstruction.js`, and a duplicate `AssignmentExpression`
  case in `mindcOptimizer.js`. `scripts/build.mjs` collapses these into one
  `note:` line so they do not drown out our own warnings. The duplicate
  `POINTER_TYPE` and `REMOTE` keys that used to be on this list were removed
  upstream.

One gap once recorded here is closed upstream as of `b3c3a30`: `for (int i = 0;
…)` parses and compiles, empty clauses (`for (; t < 3; t++)`) included. Re-checked
against the synced compiler; the extension needed no change for it.

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
a separate worker, exactly one at a time, and are cancelled by terminating that
worker.

The compiler has no cancellation hook and the optimiser is synchronous, so a
cancel message would only be read after the run it was meant to stop. The
compiler's own browser UI terminates its worker for the same reason
(`compileWorker.terminate()`). The host clears its worker reference before
terminating and checks that reference in the exit handler, so a deliberate stop
is not reported as a crash, and the next build starts a fresh thread.

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

### Stale results

A result is published only if it is still the newest request for its document.
An edit invalidates the in-flight request immediately, even though the request
that will carry the new text is still inside the debounce window; without that,
a slow run started before the edit could finish while the timer was waiting and
be shown as current. The same rule applies when a request is lost to a dead
thread: only requests still considered current are failed, so a superseded one
does not add a "stopped unexpectedly" finding to a file the user has already
moved past.

The analyser cannot be interrupted. The compiler has no cancellation hook and
the worker handles requests one at a time, so a new request waits behind a
running one. What this guarantees is that the result eventually shown describes
the newest text, not that the wait is short.

## Build-time extraction

`npm run gen` reads the compiler directly (no bundling needed) and writes:

- `syntaxes/mlgc.tmLanguage.json` — keyword, instruction, operator, type and
  `@content` rules generated from `KEYWORDS`, `SPECIAL_INSTRUCTIONS`,
  `OPERATORS`, `PUNCTUATORS`, `CONTENT_ORDER` and `DEFAULT_CONTENT_IDS`, plus
  the parser's `specials` list for types that are not keywords (`string_t`,
  `device`, `content_t`, `item_t`, …);
- `src/compiler/generated/tables.json` — the same tables in a shape the
  extension can import, including builtin signatures rendered from
  `SemanticAnalyzer#initializeBuiltinFunctions` (`returnType`, `parameters`,
  `hasVarArgs`).

`npm run gen:check` fails if either is stale, so the grammar in the repository
always matches the compiler it ships with. The compiler stays the single source
of truth for its vocabulary: a new content id, special type or builtin shows up
in the grammar and in completion after `npm run gen` with no hand-editing.

`scripts/build.mjs` also copies the compiler's `include/` directory to
`out/include`, which is what makes `#include <string.h>` resolve in an installed
extension. The directory is searched after the user's `includePaths`, so a
project's own header of the same name wins.
