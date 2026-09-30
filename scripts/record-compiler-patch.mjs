/*
 * Record a patch to the Mindustry-C compiler as a re-appliable unified diff.
 *
 * The extension applies a small, documented set of patches to the compiler
 * (see docs/COMPILER-INTEGRATION.md). Those patches have to survive the
 * compiler being refactored, so we keep them here as plain diffs that can be
 * re-applied to any checkout:
 *
 *   cd compiler && git apply ../patches/0001-expose-prepare-and-analyze.patch
 *
 * usage:
 *   node scripts/record-compiler-patch.mjs <beforeFile> <afterFile> <out.patch> [--paths <repoPath>]
 *
 * `beforeFile` / `afterFile` are snapshots of one compiler file taken
 * immediately before and after the edit, so the diff contains ONLY that edit
 * (not any of the compiler author's own uncommitted work).
 *
 * `--paths` is the path the file has inside the compiler repository, which is
 * what `git apply` needs in the `a/` and `b/` headers. It defaults to the
 * basename of `afterFile`.
 *
 * Everything is written in Node, not PowerShell: the compiler is full of CJK
 * comments, and PowerShell 5.1's `Set-Content` round-trip corrupts them.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const [, , before, after, out, ...rest] = process.argv;
if (!before || !after || !out) {
	console.error(
		'usage: node scripts/record-compiler-patch.mjs <beforeFile> <afterFile> <out.patch> [--paths <repoPath>]'
	);
	process.exit(2);
}
const pathsIdx = rest.indexOf('--paths');
// `--paths mindc.js`; tolerate `a/mindc.js` and `b/mindc.js` too, since that is
// the form a `git diff` header uses and it is easy to paste.
const targetPath = (() => {
	const given = pathsIdx >= 0 ? rest[pathsIdx + 1] : undefined;
	if (!given) return path.basename(after);
	return given.replace(/^[ab]\//, '');
})();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mindc-patch-'));
const dirA = path.join(work, 'left');
const dirB = path.join(work, 'right');
fs.mkdirSync(dirA, { recursive: true });
fs.mkdirSync(dirB, { recursive: true });

// git diff --no-index prepends a/ b/ to the paths it is given, so diffing two
// directories yields a/a/... ; diffing the two files by their relative paths
// (from `work`) and rewriting the directory part afterwards gives clean
// a/<file> b/<file> headers that `git apply` understands.
const name = path.basename(after);
fs.copyFileSync(before, path.join(dirA, name));
fs.copyFileSync(after, path.join(dirB, name));

let diff;
try {
	diff = execFileSync(
		'git',
		['diff', '--no-index', '--no-color', `left/${name}`, `right/${name}`],
		{
			cwd: work,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
		}
	);
} catch (error) {
	// git exits 1 when there are differences, which is the normal case here.
	diff = error.stdout;
	if (typeof diff !== 'string') throw error;
}

// The diff's own paths are left/mindc.js and right/mindc.js; `git apply` needs
// them to be the paths the file has in the compiler repository.
const normalised = diff
	.replaceAll(`a/left/${name}`, `a/${targetPath}`)
	.replaceAll(`b/left/${name}`, `b/${targetPath}`)
	.replaceAll(`a/right/${name}`, `a/${targetPath}`)
	.replaceAll(`b/right/${name}`, `b/${targetPath}`);

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, normalised, 'utf8');

const added = (normalised.match(/^\+(?!\+\+)/gm) || []).length;
const removed = (normalised.match(/^-(?!--)/gm) || []).length;
process.stdout.write(`wrote ${out} (+${added} -${removed} lines)\n`);
