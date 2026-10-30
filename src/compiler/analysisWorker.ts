/*
 * The analysis worker.
 *
 * Runs in a `worker_threads` thread: the compiler is a single-threaded,
 * occasionally quadratic pile of loops, and a frozen extension host is not an
 * acceptable failure mode. A crash here takes down this thread only -- the
 * supervisor answers any request this thread was holding, so the document is
 * told it went unchecked, and starts a fresh thread on the next one.
 *
 * Protocol (parent -> worker): AnalysisRequest | KnownDocumentsMessage
 *                            (worker -> parent): AnalysisResponse
 */

import { parentPort, workerData } from 'node:worker_threads';

import { analyse } from './analysis';
import { silenceCompilerLogs } from './bridge';
import { createDocumentAccess, type KnownDocuments } from './documentAccess';
import type { AnalysisRequest, KnownDocumentsMessage } from '../common/types';

interface WorkerBootstrap {
	/** Documents the worker may read for `#include`, by uri. */
	knownPaths: KnownDocuments;
}

const port = parentPort;
if (!port) throw new Error('analysisWorker must be run as a worker thread');

silenceCompilerLogs();

const bootstrap = (workerData ?? { knownPaths: {} }) as WorkerBootstrap;

/*
 * Documents are handed to the worker rather than read from disk: the editor
 * holds unsaved buffers, and a header saved only in the editor must still
 * resolve. Files on disk are the fallback for anything the editor does not own.
 * Which is which, and why `pathOf` must never answer with the buffer, is
 * documentAccess.ts.
 */
let access = createDocumentAccess(bootstrap.knownPaths);

port.on('message', (message: AnalysisRequest | KnownDocumentsMessage) => {
	// Buffers changed since this thread started. The access object is rebuilt
	// rather than mutated, so an analysis already running keeps the map it was
	// handed and the next one gets the new text.
	if ('type' in message) {
		access = createDocumentAccess(message.documents);
		return;
	}

	void (async () => {
		try {
			const response = await analyse(message, access);
			port!.postMessage(response);
		} catch (error) {
			port!.postMessage({
				id: message.id,
				uri: message.uri,
				diagnostics: [],
				index: null,
				fatal: error instanceof Error ? (error.stack ?? error.message) : String(error),
			});
		}
	})();
});
