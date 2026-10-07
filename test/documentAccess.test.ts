/*
 * The two lookups the compiler makes about files.
 *
 * These are tested in isolation because the mistake they guard against is
 * invisible everywhere else: `pathOf` used to answer with the buffer's text,
 * and nothing in a unit test noticed, because the value only matters once a
 * server turns it into a URI and an editor decides whether to draw a squiggle.
 * The other end of that is test/lsp.test.ts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { URI } from 'vscode-uri';

import { createDocumentAccess, uriToPath } from '../src/compiler/documentAccess';

const TEXT = 'int main(void) { return 0; }\n';
const MAIN = 'file:///c:/proj/main.mlgc';

/** A temporary directory that is removed whatever the test does. */
function scratch(body: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindc-access-'));
	try {
		body(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe('pathOf', () => {
	it('answers with a filesystem path, never with the buffer it was given', () => {
		const access = createDocumentAccess({ [MAIN]: TEXT });

		// The whole bug: reading `known[uri]` straight back returns the text,
		// which the server then turns into a URI out of the file's own contents.
		assert.equal(access.pathOf(MAIN), 'c:/proj/main.mlgc');
		assert.notEqual(access.pathOf(MAIN), TEXT);
	});

	it('reads a drive letter the editor percent-encoded', () => {
		// What a real uri looks like: URI.file() writes `c%3A`, not `c:`. The
		// decoding used to happen after the slash was stripped, the pattern
		// never matched, and the result kept its leading slash -- so it matched
		// nothing, silently, for every file on Windows.
		assert.equal(createDocumentAccess({}).pathOf('file:///c%3A/proj/main.mlgc'), 'c:/proj/main.mlgc');
	});

	it('decodes what the editor percent-encoded', () => {
		assert.equal(createDocumentAccess({}).pathOf('file:///c:/x%20y/a.mlgc'), 'c:/x y/a.mlgc');
	});

	it('leaves a POSIX path alone, leading slash included', () => {
		assert.equal(createDocumentAccess({}).pathOf('file:///home/u/a.mlgc'), '/home/u/a.mlgc');
	});

	it('returns null for a document with no location on disk', () => {
		// An untitled buffer has a uri but no file: nothing may be attributed to
		// it, and inventing a path would be worse than saying so.
		assert.equal(createDocumentAccess({ 'untitled:Untitled-1': TEXT }).pathOf('untitled:Untitled-1'), null);
	});
});

describe('readFile', () => {
	it('prefers the editor buffer for a path the editor owns', () => {
		scratch(dir => {
			const file = path.join(dir, 'header.h');
			fs.writeFileSync(file, '// on disk\n');

			// Keyed the way the server keys it: by uri, produced with the same
			// URI.file() the server uses.
			const access = createDocumentAccess({ [URI.file(file).toString()]: '// in the editor\n' });

			assert.equal(access.readFile(file), '// in the editor\n', 'the buffer must win over a stale disk file');
			// Windows spells the same file in at least three ways, and an
			// include resolves against whatever the compiler happened to build.
			assert.equal(access.readFile(file.replace(/\\/g, '/')), '// in the editor\n');
		});
	});

	it('reads from disk for anything the editor does not own', () => {
		scratch(dir => {
			const file = path.join(dir, 'on-disk.h');
			fs.writeFileSync(file, '#define FROM_DISK 1\n');

			const access = createDocumentAccess({});

			assert.equal(access.readFile(file), '#define FROM_DISK 1\n');
			assert.equal(access.readFile(path.join(dir, 'missing.h')), null, 'a missing include must be null, not a throw');
		});
	});

	it('folds case only where the filesystem does', () => {
		const access = createDocumentAccess({ [MAIN]: TEXT });
		const upper = access.readFile('C:\\PROJ\\MAIN.MLGC');

		if (process.platform === 'win32') {
			assert.equal(upper, TEXT);
		} else {
			// Folding case here would merge two genuinely different files.
			assert.equal(upper, null);
		}
	});

	it('accepts a uri where it was asked for a path', () => {
		// Not something the compiler does today, but it did once, and the cost
		// of being wrong is a header silently read from the wrong place.
		const access = createDocumentAccess({ [MAIN]: TEXT });
		assert.equal(access.readFile(MAIN), TEXT);
	});
});

describe('uriToPath', () => {
	it('is null for anything that is not a file', () => {
		assert.equal(uriToPath('untitled:Untitled-1'), null);
		assert.equal(uriToPath('not a uri at all'), null);
	});
});
