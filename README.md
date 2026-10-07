# Mindustry-C

Language support for **Mindustry-C**, the C dialect that compiles to Mindustry
Logic (`mlog`).

- **Diagnostics while you type**, from the compiler's own semantic analysis —
  parse and analyse only, debounced, on a worker thread so a compiler crash
  cannot take the editor with it.
- **Navigation**: go to definition, find references, rename symbol, hover,
  completion.
- **A compile button** in the editor title bar. The `mlog` opens in a read-only
  preview and can be copied to the clipboard; nothing is ever written to disk.
- **Syntax highlighting generated from the compiler's own token tables**, so it
  follows the dialect rather than generic C.

## Trying it

### From source, with F5

Open this folder in VS Code and press **F5**. A second window — an Extension
Development Host — opens with the extension running; open any `.mlgc` file
there.

After changing the source, run `npm run build` (or leave `npm run watch`
running) and press **Ctrl+R** / **Cmd+R** in the Development Host to reload it.

### As an installed extension

```sh
npm install
npm run build
npx @vscode/vsce package
```

That writes `mindustry-c-vscode-<version>.vsix` next to `package.json` (`*.vsix`
is git-ignored, so the tree stays clean). In VS Code, open the Command Palette,
run **Extensions: Install from VSIX…**, pick the file, and reload when prompted.
To remove it, find *Mindustry-C* on the Extensions page and Uninstall.

## Commands

All under the **Mindustry C** category:

| Command | What it does |
| --- | --- |
| Compile to Mindustry Logic | Build the current file and open the preview. |
| Compile and Copy Output | Build and put the result on the clipboard. |
| Cancel Compilation | Stop the build in progress. |
| Show Compiled Output | Reopen the preview for the last build. |
| Copy Compiled Output | Copy the output of the last build. |
| Open Configuration File | Open the configuration file currently in effect. |
| Configure Target and Memory | Edit target version and memory blocks. |
| Reload Mindustry-C Compiler | Re-read the compiler after it changed on disk. |

*Compile to Mindustry Logic* and *Configure Target and Memory* also appear as
buttons in the editor title bar for `.mlgc` files.

## Configuration

Two JSON files, both named `mlgc.json`, merged with the workspace one on top:

| File | Scope |
| --- | --- |
| `~/.mindustry-c/mlgc.json` | User-level defaults |
| `.vscode/mlgc.json` | This project, overriding the above |

Both are validated against `schemas/mlgc.schema.json`. Editing either changes
the raw file for that scope; *Configure Target and Memory* is the guided way to
do it. Settings that govern the extension itself — debounce window, large-file
warning, preview behaviour — are ordinary VS Code settings under **Mindustry-C**.

## Development

```sh
npm run check      # typecheck, grammar freshness, tests, golden output, patch neutrality
npm run build      # the five bundles that make up the extension
npm run gen        # regenerate the TextMate grammar from the compiler's tables
```

How this talks to the compiler, what was patched to make that possible, and the
known rough edges are all in [docs/COMPILER-INTEGRATION.md](docs/COMPILER-INTEGRATION.md).
