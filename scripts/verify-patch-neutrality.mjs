/*
 * Prove that our compiler patches change nothing about what gets compiled.
 *
 * The extension depends on a patched compiler, and the compiler's internals
 * move without notice. The claim that a patch is behaviour-neutral is only
 * worth anything if it can be re-checked, so this:
 *
 *   1. copies the compiler tree as it stands (author's WIP included),
 *   2. reverse-applies every patch in patches/ to get the unpatched tree,
 *   3. compiles all of compiler/testers/*.c against both, and
 *   4. diffs success flags, output hashes, line counts, and every error and
 *      warning with its position.
 *
 *   node scripts/verify-patch-neutrality.mjs
 *
 * Exit code 0 means identical. A non-zero exit prints the first differences.
 *
 * Note what this does and does not prove: it proves our patches are neutral
 * *for the compiler as it stands today*. It says nothing about the author's own
 * uncommitted work, which is present in both trees and therefore cancels out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compilerDir = process.env.MINDC_COMPILER_DIR ?? path.join(root, 'compiler');
const patchDir = path.join(root, 'patches');

const patches = fs
	.readdirSync(patchDir)
	.filter(file => file.endsWith('.patch'))
	.sort()
	.map(file => path.join(patchDir, file));

if (patches.length === 0) {
	console.log('no patches to verify');
	process.exit(0);
}
if (!fs.existsSync(path.join(compilerDir, 'testers'))) {
	console.error(`${compilerDir} has no testers/ directory; nothing to compare.`);
	process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mindc-neutral-'));
try {
	const patched = path.join(work, 'patched');
	const unpatched = path.join(work, 'unpatched');
	fs.cpSync(compilerDir, patched, {
		recursive: true,
		// .git is large and irrelevant; the callers below do not need history.
		filter: source => path.basename(source) !== '.git',
	});
	fs.cpSync(patched, unpatched, { recursive: true });

	// `git apply -R` needs a repository; the extension repo's own git is fine.
	execFileSync('git', ['init', '-q'], { cwd: unpatched });
	for (const patch of patches) {
		try {
			execFileSync('git', ['apply', '-R', '--whitespace=nowarn', patch], {
				cwd: unpatched,
				stdio: ['ignore', 'ignore', 'pipe'],
			});
		} catch (error) {
			console.error(`Could not reverse-apply ${path.basename(patch)}:`);
			console.error(String(error.stderr ?? error.message));
			process.exit(1);
		}
	}

	const before = JSON.parse(run(unpatched));
	const after = JSON.parse(run(patched));

	const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	const differences = [];
	for (const name of names) {
		const a = JSON.stringify(before[name]);
		const b = JSON.stringify(after[name]);
		if (a !== b) differences.push({ name, unpatched: before[name], patched: after[name] });
	}

	const compiled = names.filter(name => after[name]?.success).length;
	console.log(
		`compared ${names.length} tester file(s) across ${patches.length} patch(es); ` +
			`${compiled} compile successfully`
	);
	if (differences.length === 0) {
		console.log('no behavioural difference: the patches are neutral.');
		process.exit(0);
	}
	console.error(`\n${differences.length} file(s) differ:`);
	for (const difference of differences.slice(0, 10)) {
		console.error(`\n--- ${difference.name}`);
		console.error(`  unpatched: ${JSON.stringify(difference.unpatched)}`);
		console.error(`  patched:   ${JSON.stringify(difference.patched)}`);
	}
	if (differences.length > 10) console.error(`\n... and ${differences.length - 10} more.`);
	process.exit(1);
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}

function run(tree) {
	return execFileSync(process.execPath, [path.join(root, 'scripts', 'compile-hashes.mjs'), tree], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'inherit'],
	});
}
