/*
 * How a worker answers the two questions the compiler asks about files.
 *
 * The server hands every worker `uri -> text` for the documents the editor is
 * holding, so that a buffer saved only in the editor still resolves for
 * `#include`. That map is keyed by uri, and neither question is "give me the
 * entry for this uri":
 *
 *   `pathOf(uri)` is asked for an **fs path**. A diagnostic's `path`, the symbol
 *   index's `path`, and the base that a relative `#include` resolves against are
 *   all made of it. Answering with the buffer's text -- which is what reading
 *   `known[uri]` does -- sends every finding for the file to a URI built out of
 *   the file's own contents, points definition and references at the same
 *   nonsense, and resolves includes against it. None of that surfaces as an
 *   error: the server answers `initialize` with all its capabilities and the
 *   file simply looks checked.
 *
 *   `readFile(path)` is asked with an fs path, so the uri-keyed map has to be
 *   turned around first, separators and (on Windows) case included.
 *
 * Both used to be answered straight out of `known`, in each worker, with the
 * result above. One implementation, so they cannot drift apart again.
 */

import { readFileSync } from 'node:fs';

/** `uri -> text` for every document the editor currently has open. */
export type KnownDocuments = Record<string, string>;

export interface DocumentAccess {
	/** The file's own path, or null for a document with no location on disk. */
	pathOf(uri: string): string | null;
	/** Buffer text when the editor owns this path, the file on disk otherwise. */
	readFile(path: string): string | null;
}

export function createDocumentAccess(known: KnownDocuments): DocumentAccess {
	// Resolved once: an include-heavy file walks this for every `#include`.
	const buffers = new Map<string, string>();
	for (const [uri, text] of Object.entries(known)) {
		const file = uriToPath(uri);
		if (file) buffers.set(fold(file), text);
	}

	return {
		pathOf: uri => uriToPath(uri),
		readFile(candidate) {
			// The compiler resolves includes against `filePath`, so it asks with
			// paths -- but a uri slipped through once, and asking is cheaper than
			// guessing which it meant.
			const path = candidate.startsWith('file://') ? uriToPath(candidate) ?? candidate : candidate;
			const buffer = buffers.get(fold(path));
			if (buffer !== undefined) return buffer;
			try {
				return readFileSync(path, 'utf8');
			} catch {
				return null;
			}
		},
	};
}

/**
 * `file://` to the path the compiler wants; null for anything not on disk.
 *
 * The percent-decoding has to happen *before* the drive letter is un-slashed:
 * `URI.file()` writes a Windows drive as `c%3A`, and the pattern that recognises
 * `/c:` does not recognise `/c%3A` -- so decoding afterwards leaves the leading
 * slash on, and every path built from a real editor uri is off by one
 * character, which is enough for nothing to ever match.
 */
export function uriToPath(uri: string): string | null {
	if (!uri.startsWith('file://')) return null;
	try {
		return decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:)/, '$1');
	} catch {
		return null;
	}
}

/** Whether two paths name the same file, on the filesystem this runs on. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return fold(a) === fold(b);
}

/**
 * Fold a path so two spellings of one file compare equal.
 *
 * Windows accepts `c:\x`, `C:/x` and any casing of either, so it is folded
 * there and only there: folding case everywhere would quietly merge two
 * distinct files on a case-sensitive filesystem.
 */
function fold(path: string): string {
	const slashed = path.replace(/\\/g, '/');
	return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}
