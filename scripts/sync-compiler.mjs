/*
 * Pull a newer Mindustry-C compiler into the extension and re-apply our patches.
 *
 * `compiler/` is its own clone of the compiler repository, and the two patches
 * live in `patches/` rather than in that clone's history. A compiler update is
 * therefore: fetch the upstream, reset the clone to it, apply every patch, and
 * then prove the result still analyses and compiles the same way. This does the
 * first three, and the rest on request.
 *
 *   node scripts/sync-compiler.mjs --dry-run
 *       fetch and show what would come in; change nothing.
 *
 *   node scripts/sync-compiler.mjs
 *       sync and apply the patches.
 *
 *   node scripts/sync-compiler.mjs --check
 *       ... and then `npm run check`.
 *
 *   node scripts/sync-compiler.mjs --package
 *       ... then check, bump the patch version, and build the .vsix.
 *       `--bump minor`, `--bump major`, or `--bump none` to rebuild as-is.
 *
 * The upstream defaults to ../mindustry-c, the checkout the compiler is
 * developed in. That checkout is usually ahead of `origin`, which is why this
 * fetches by path rather than from the remote. Override with --upstream or
 * MINDC_UPSTREAM.
 *
 * Nothing that needs a judgement is automated. If the grammar tables moved the
 * script stops and asks for `npm run gen`; if the compiled output changed it
 * asks for a review before `npm run test:golden:update`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compilerDir = path.join(root, 'compiler');
const patchDir = path.join(root, 'patches');

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		upstream: { type: 'string' },
		branch: { type: 'string', default: 'main' },
		'dry-run': { type: 'boolean', default: false },
		check: { type: 'boolean', default: false },
		package: { type: 'boolean', default: false },
		bump: { type: 'string', default: 'patch' },
		help: { type: 'boolean', short: 'h', default: false },
	},
});

if (values.help) {
	console.log(`Usage: node scripts/sync-compiler.mjs [upstream] [options]

  upstream            compiler checkout to fetch from (default ../mindustry-c,
                      or MINDC_UPSTREAM)
  --upstream <path>   same, as a flag
  --branch <name>     branch to fetch (default main)
  --dry-run           fetch and show what is new, without changing anything
  --check             run \`npm run check\` after applying the patches
  --package           check, bump the version and build the .vsix
  --bump <kind>       patch (default), minor, major, or none
  -h, --help          this text

Exit codes: 0 done, 1 failed, 2 usage error.`);
	process.exit(0);
}

if (positionals.length > 1) usage('at most one positional upstream path');

const bump = String(values.bump ?? 'patch');
if (!['patch', 'minor', 'major', 'none'].includes(bump)) {
	usage(`--bump must be patch, minor, major or none, not "${bump}"`);
}

const upstream = path.resolve(
	String(values.upstream ?? positionals[0] ?? process.env.MINDC_UPSTREAM ?? path.join(root, '..', 'mindustry-c'))
);
const branch = String(values.branch);
const wantCheck = Boolean(values.check) || Boolean(values.package);
const wantPackage = Boolean(values.package);

usageErrorIfMissing();
sync();

if (wantCheck) runCheck();
if (wantPackage) runPackage();
finish();

/* ------------------------------------------------------------------ */

function usage(message) {
	console.error(`sync-compiler: ${message}`);
	process.exit(2);
}

function usageErrorIfMissing() {
	if (!fs.existsSync(compilerDir)) {
		fail(
			`no compiler checkout at ${compilerDir}\n` +
				'Clone the compiler repository there, or set --upstream to where it lives.'
		);
	}
	if (!fs.existsSync(path.join(upstream, 'mindc.js')) || !fs.existsSync(path.join(upstream, 'mindcLexer.js'))) {
		fail(`${upstream} does not look like a compiler checkout (no mindc.js / mindcLexer.js).`);
	}
	if (!isRepo(upstream)) {
		fail(`upstream is not a git checkout: ${upstream}`);
	}
	if (!isRepo(compilerDir)) {
		fail(`${compilerDir} is not a git checkout.`);
	}
	if (patches().length === 0) {
		fail(`no *.patch files in ${patchDir}.`);
	}
}

function sync() {
	const patchesToApply = patches();
	const before = head();

	console.log(`compiler  ${displayHead(before)}`);
	console.log(`upstream  ${upstream} (${branch})`);
	console.log(`patches   ${patchesToApply.join(', ')}`);

	run(['fetch', '--quiet', upstream, branch], 'fetch');

	const incoming = git(['rev-parse', 'FETCH_HEAD'], 'read FETCH_HEAD').trim();
	const isNew = incoming !== before;
	if (isNew) {
		const count = before ? Number(git(['rev-list', '--count', `${before}..${incoming}`], 'count commits').trim()) : 0;
		console.log(`\n${count} new commit(s): ${displayHead(before)} -> ${displayHead(incoming)}`);
	} else {
		console.log('\nAlready at the upstream revision.');
	}

	if (values['dry-run']) {
		if (isNew) {
			const log = git(['log', '--oneline', '--max-count=20', `${before ?? incoming}..${incoming}`], 'read log');
			if (log.trim()) console.log(indent(log.trim()));
		}
		console.log('\nDry run; nothing changed.');
		return;
	}

	// Reset even when nothing came in: the working tree is where the patches
	// live, and starting from a clean checkout is what makes this repeatable.
	backupLocalChanges();
	run(['reset', '--hard', incoming], 'reset');

	// Re-apply after every reset, including a no-op one: the working tree is
	// clean at this point and the patches are the only diff it should carry.
	for (const name of patchesToApply) {
		const file = path.join(patchDir, name);
		const check = spawnSync('git', ['apply', '--check', file], { cwd: compilerDir, encoding: 'utf8' });
		if (check.error) fail(check.error.message);
		if (check.status !== 0) {
			console.error(`\n${name} no longer applies to ${displayHead(head())}:\n`);
			console.error(indent((check.stderr || check.stdout || '').trim()));
			console.error(
				'\nThe checkout is now at that revision with NO patches applied.\n' +
					'Re-port the patch against it (docs/COMPILER-INTEGRATION.md, "Patches"),\n' +
					`then run this script again. To go back instead: \`git -C compiler reset --hard ${before ?? '<old>'}\`.`
			);
			process.exit(1);
		}
		run(['apply', file], `apply ${name}`);
	}

	const changed = git(['status', '--porcelain'], 'read status').trim();
	console.log(`\nApplied ${patchesToApply.length} patch(es). Checkout now carries:`);
	console.log(changed ? indent(changed) : '  (nothing?)');
}

function runCheck() {
	console.log('\n== npm run check ==\n');
	if (!shell('npm run check')) {
		console.error(`
The sync itself succeeded: the compiler is at ${displayHead(head())} with the
patches applied. Only the check above failed -- nothing was versioned or
packaged. The failing step is the last "> npm run ..." line printed above.

What it usually means:

  gen:check       the compiler's keyword/instruction/content tables changed.
                  Run \`npm run gen\`, review the diff under syntaxes/ and
                  src/compiler/generated/, then commit it.

  test            the AST contract the extension relies on moved. Fix
                  src/compiler/symbols.ts or src/compiler/analysis.ts.

  test:golden     the compiled output changed. Review the listed files, then
                  \`npm run test:golden:update\`.

  patches:verify  the patches are no longer behaviour-neutral. Re-port them.
`);
		process.exit(1);
	}
}

function runPackage() {
	if (bump !== 'none') {
		console.log(`\n== npm version ${bump} ==\n`);
		if (!shell(`npm version ${bump} --no-git-tag-version`)) fail('could not bump the version.');
	}

	console.log('\n== vsce package ==\n');
	if (!shell('npx --yes @vscode/vsce package')) fail('packaging failed.');

	const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const vsix = path.join(root, `${manifest.name}-${manifest.version}.vsix`);
	if (!fs.existsSync(vsix)) fail(`vsce reported success but ${vsix} is not there.`);
	console.log(`\nBuilt ${path.basename(vsix)} (${Math.round(fs.statSync(vsix).size / 1024)} KB).`);
}

function finish() {
	if (!wantPackage) return;
	console.log('\nNext: review the changes and commit them:');
	console.log('  git status --short');
	console.log('  git add package.json package-lock.json test/golden/compile.json syntaxes/ src/compiler/generated/ docs/');
	console.log('  git commit -m "chore(compiler): sync to <revision>"');
}

/* ------------------------------------------------------------------ */

function patches() {
	return fs
		.readdirSync(patchDir)
		.filter(name => name.endsWith('.patch'))
		.sort();
}

function isRepo(dir) {
	return spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' }).status === 0;
}

function head() {
	const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: compilerDir, encoding: 'utf8' });
	return result.status === 0 ? result.stdout.trim() : null;
}

function displayHead(revision) {
	return revision ? revision.slice(0, 7) : '(empty)';
}

function git(args, what) {
	const result = spawnSync('git', args, { cwd: compilerDir, encoding: 'utf8' });
	if (result.error) fail(result.error.message);
	if (result.status !== 0) {
		fail(`could not ${what}: git ${args.join(' ')}\n${indent((result.stderr || '').trim())}`);
	}
	return result.stdout;
}

function run(args, what) {
	const result = spawnSync('git', args, { cwd: compilerDir, encoding: 'utf8' });
	if (result.error) fail(result.error.message);
	if (result.status !== 0) {
		fail(`could not ${what}: git ${args.join(' ')}\n${indent((result.stderr || '').trim())}`);
	}
}

/**
 * Save whatever the checkout had uncommitted before the reset.
 *
 * Normally that is just our patches, which are reproducible from `patches/`.
 * If someone hand-edited the compiler, this is the only copy of it.
 */
function backupLocalChanges() {
	const status = spawnSync('git', ['status', '--porcelain'], { cwd: compilerDir, encoding: 'utf8' }).stdout ?? '';
	if (!status.trim()) return;

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const file = path.join(root, 'out', 'compiler-wip', `${stamp}.diff`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const diff = spawnSync('git', ['diff'], { cwd: compilerDir, encoding: 'utf8' }).stdout ?? '';
	fs.writeFileSync(file, diff);

	console.log(`Saved the checkout's uncommitted diff to ${path.relative(root, file)}`);
	const untracked = status.split('\n').filter(line => line.startsWith('??'));
	if (untracked.length > 0) {
		console.log(`Note: ${untracked.length} untracked file(s) there are NOT in that diff:`);
		console.log(indent(untracked.join('\n')));
	}
}

function shell(command) {
	// A single command string: passing an args array together with `shell` is
	// deprecated (and needs quoting rules that differ per platform). Every
	// caller passes a literal except `npm version`, whose argument is one of
	// four validated words.
	const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true });
	if (result.error) fail(result.error.message);
	return result.status === 0;
}

function indent(text) {
	return text
		.split('\n')
		.map(line => `  ${line}`)
		.join('\n');
}

function fail(message) {
	console.error(`\nsync-compiler: ${message}`);
	process.exit(1);
}
