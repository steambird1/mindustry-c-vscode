/*
 * The build worker.
 *
 * A full compile runs the optimiser, whose fixed-point loop costs about 36 s on
 * a 100 KB file. That is far too slow to do on the extension host's thread, and
 * far too slow to leave running once the user has moved on, so builds get their
 * own thread and are cancellable.
 *
 * Protocol (parent -> worker): BuildRequest | KnownDocumentsMessage
 *                            (worker -> parent): BuildResponse
 *
 * Cancellation is the parent's business: it terminates the thread, because the
 * optimiser is synchronous and could not read a cancel message anyway.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { compile } from './bridge';
import { silenceCompilerLogs } from './bridge';
import { attributeDiagnostics } from './analysis';
import { createDocumentAccess, type KnownDocuments } from './documentAccess';
import type { BuildRequest, BuildResponse, KnownDocumentsMessage } from '../common/types';

interface WorkerBootstrap {
	knownPaths: KnownDocuments;
}

const port = parentPort;
if (!port) throw new Error('buildWorker must be run as a worker thread');

silenceCompilerLogs();

const bootstrap = (workerData ?? { knownPaths: {} }) as WorkerBootstrap;

// Which file is which, and why the answer is never the buffer's text, is
// documentAccess.ts.
let access = createDocumentAccess(bootstrap.knownPaths);

port.on('message', (message: BuildRequest | KnownDocumentsMessage) => {
	if ('type' in message) {
		access = createDocumentAccess(message.documents);
		return;
	}
	void run(message);
});

async function run(request: BuildRequest): Promise<void> {
	try {
		const result = await compile({
			source: request.text,
			target: {
				targetVersion: request.config.targetVersion,
				memoryBlocks: request.config.memoryBlocks,
				includePaths: request.config.includePaths,
			},
			filePath: access.pathOf(request.uri),
			readFile: access.readFile,
		});

		const { errors, warnings } = attributeDiagnostics(
			result.errors,
			result.warnings,
			result.tokens,
			access.pathOf(request.uri),
			result.sources
		);

		const response: BuildResponse = {
			id: request.id,
			ok: true,
			success: result.success,
			code: result.code,
			instructionCount: result.code ? result.code.split('\n').length : 0,
			errors,
			warnings,
			...(result.fatalError ? { fatalError: result.fatalError } : {}),
			elapsedMs: result.elapsedMs,
		};
		port!.postMessage(response);
	} catch (error) {
		port!.postMessage({
			id: request.id,
			ok: false,
			success: false,
			code: '',
			instructionCount: 0,
			errors: [
				{
					severity: 'error',
					message: error instanceof Error ? error.message : String(error),
				},
			],
			warnings: [],
			fatalError: error instanceof Error ? (error.stack ?? error.message) : String(error),
			elapsedMs: 0,
		} satisfies BuildResponse);
	}
}
