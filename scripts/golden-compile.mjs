/*
 * Pin what the compiler produces, so a change to the compiler -- ours or the
 * author's -- cannot silently alter generated code.
 *
 * The extension is a front end for someone else's compiler. When the output
 * changes, the user has to be told it changed, and the only honest way to know
 * is to have recorded what it was. This compiles every file in
 * `compiler/testers/` and compares a fingerprint per file against
 * `test/golden/compile.json`.
 *
 *   node scripts/golden-compile.mjs            # compare
 *   node scripts/golden-compile.mjs --update   # re-record
 *
 * Only files that compile successfully are recorded. The 13 testers that fail
 * today fail for reasons unrelated to this extension (unimplemented intrinsics,
 * a `targetTypeRaw.duplicate` that does not exist, an undeclared identifier in
 * a codegen path); pinning their fingerprints would mean re-recording on every
 * compiler bug fix. A file that *starts* compiling shows up as a new entry and
 * is worth a look; a file that *stops* compiling is always a failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldenFile = path.join(root, 'test', 'golden', 'compile.json');
const update = process.argv.includes('--update');

const current = JSON.parse(
	execFileSync(process.execPath, [path.join(root, 'scripts', 'compile-hashes.mjs')], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'inherit'],
	})
);

const good = Object.fromEntries(
	Object.entries(current)
		.filter(([, entry]) => entry.success)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
);

if (update) {
	fs.mkdirSync(path.dirname(goldenFile), { recursive: true });
	fs.writeFileSync(
		goldenFile,
		JSON.stringify({ compiler: compilerRevision(), files: good }, null, '\t') + '\n',
		'utf8'
	);
	console.log(`recorded ${Object.keys(good).length} compiling tester(s) to ${path.relative(root, goldenFile)}`);
	process.exit(0);
}

if (!fs.existsSync(goldenFile)) {
	console.error(`No golden file at ${path.relative(root, goldenFile)}. Run: npm run test:golden:update`);
	process.exit(1);
}

const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
const problems = [];

const revision = compilerRevision();
if (golden.compiler && golden.compiler !== revision) {
	// Not a failure: the compiler moves on its own schedule. Worth saying out
	// loud, though, because it is the first thing to check when a hash moves.
	console.log(`note: recorded against compiler ${golden.compiler}, this is ${revision}.`);
}

// A file that used to compile and no longer does is always a failure, even
// though uncompilable files are not recorded.
for (const [name, entry] of Object.entries(golden.files)) {
	const now = current[name];
	if (!now) problems.push(`${name}: no longer in compiler/testers/`);
	else if (!now.success) problems.push(`${name}: no longer compiles (${firstError(now)})`);
	else if (now.hash !== entry.hash) {
		problems.push(
			`${name}: output changed\n    was ${entry.hash} (${entry.lines} lines)\n    now ${now.hash} (${now.lines} lines)`
		);
	}
}

const recorded = new Set(Object.keys(golden.files));
const added = Object.keys(good).filter(name => !recorded.has(name));
if (added.length > 0) {
	console.log(
		`note: ${added.length} tester(s) compile now but were not recorded ` +
			`(${added.slice(0, 5).join(', ')}${added.length > 5 ? ', ...' : ''}). ` +
			'Re-record with: npm run test:golden:update'
	);
}

const failing = Object.keys(current).filter(name => !current[name].success);
console.log(
	`${Object.keys(good).length} of ${Object.keys(current).length} tester(s) compile; ` +
		`${failing.length} do not (not recorded)`
);

if (problems.length === 0) {
	console.log('generated code matches the recorded fingerprints.');
	process.exit(0);
}
console.error(`\n${problems.length} difference(s):`);
for (const problem of problems) console.error(`  ${problem}`);
process.exit(1);

function firstError(entry) {
	const error = entry.errors?.[0] ?? entry.threw ?? 'unknown';
	return String(error).split('\n')[0];
}

/**
 * Which compiler produced these fingerprints.
 *
 * Recorded alongside the hashes so that a mismatch can be attributed straight
 * away: the compiler has its own repository, on its own schedule, and most
 * output changes come from there rather than from us.
 */
function compilerRevision() {
	try {
		return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
			cwd: path.join(root, 'compiler'),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return null;
	}
}
