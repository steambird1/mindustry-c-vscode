/*
 * The build worker.
 *
 * A full compile runs the optimiser, whose fixed-point loop costs about 36 s on
 * a 100 KB file. That is far too slow to do on the extension host's thread, and
 * far too slow to leave running once the user has moved on, so builds get their
 * own thread and are cancellable.
 *
 * Protocol (parent -> worker): BuildRequest | {type: 'cancel', id}
 *                            (worker -> parent): BuildResponse
 */

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';

import { compile } from './bridge';
import { silenceCompilerLogs } from './bridge';
import { attributeDiagnostics } from './analysis';
import type { BuildRequest, BuildResponse } from '../common/types';

interface WorkerBootstrap {
	knownPaths: Record<string, string>;
}

const port = parentPort;
if (!port) throw new Error('buildWorker must be run as a worker thread');

silenceCompilerLogs();

const bootstrap = (workerData ?? { knownPaths: {} }) as WorkerBootstrap;

/** Ids that were cancelled while a run was in flight. */
const cancelled = new Set<number>();

function readFile(candidate: string): string | null {
	for (const [uri, known] of Object.entries(bootstrap.knownPaths)) {
		if (candidate === known || uri === candidate) return known;
	}
	try {
		return readFileSync(candidate, 'utf8');
	} catch {
		return null;
	}
}

interface CancelMessage {
	type: 'cancel';
	id: number;
}

port.on('message', (message: BuildRequest | CancelMessage) => {
	if ('type' in message) {
		cancelled.add(message.id);
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
			filePath: pathOf(request.uri),
			readFile,
		});

		if (cancelled.delete(request.id)) return;

		const { errors, warnings } = attributeDiagnostics(
			result.errors,
			result.warnings,
			result.tokens,
			pathOf(request.uri),
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
		if (cancelled.delete(request.id)) return;
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

function pathOf(uri: string): string | null {
	const known = bootstrap.knownPaths[uri];
	if (known) return known;
	if (!uri.startsWith('file://')) return null;
	try {
		return decodeURIComponent(new URL(uri).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
	} catch {
		return null;
	}
}
