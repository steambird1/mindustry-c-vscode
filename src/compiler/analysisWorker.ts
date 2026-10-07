/*
 * The analysis worker.
 *
 * Runs in a `worker_threads` thread: the compiler is a single-threaded,
 * occasionally quadratic pile of loops, and a frozen extension host is not an
 * acceptable failure mode. A crash here takes down this thread only -- the
 * supervisor answers any request this thread was holding, so the document is
 * told it went unchecked, and starts a fresh thread on the next one.
 *
 * Protocol (parent -> worker): AnalysisRequest
 *                            (worker -> parent): AnalysisResponse
 */

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

import { analyse } from './analysis';
import { silenceCompilerLogs } from './bridge';
import type { AnalysisRequest } from '../common/types';

interface WorkerBootstrap {
	/** Documents the worker may read for `#include`, by uri. */
	knownPaths: Record<string, string>;
}

const port = parentPort;
if (!port) throw new Error('analysisWorker must be run as a worker thread');

silenceCompilerLogs();

const bootstrap = (workerData ?? { knownPaths: {} }) as WorkerBootstrap;

/**
 * Documents are handed to the worker rather than read from disk: the editor
 * holds unsaved buffers, and a header saved only in the editor must still
 * resolve. Files on disk are the fallback for anything the editor does not own.
 */
function readFile(path: string): string | null {
	for (const [uri, known] of Object.entries(bootstrap.knownPaths)) {
		if (path === known || uri === path) return known;
	}
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

port.on('message', (request: AnalysisRequest) => {
	void (async () => {
		try {
			const response = await analyse(request, {
				readFile,
				pathOf: uri => bootstrap.knownPaths[uri] ?? uriToPath(uri),
			});
			port!.postMessage(response);
		} catch (error) {
			port!.postMessage({
				id: request.id,
				uri: request.uri,
				diagnostics: [],
				index: null,
				fatal: error instanceof Error ? (error.stack ?? error.message) : String(error),
			});
		}
	})();
});

function uriToPath(uri: string): string | null {
	if (!uri.startsWith('file://')) return null;
	try {
		return decodeURIComponent(new URL(uri).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
	} catch {
		return null;
	}
}
