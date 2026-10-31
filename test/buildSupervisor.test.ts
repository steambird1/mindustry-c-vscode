/*
 * Cancelling a build.
 *
 * The compiler has no cancellation hook and the optimiser is synchronous, so a
 * cancel *message* would only be read after the run it was meant to stop. The
 * host terminates the thread instead -- which is what the compiler's own
 * browser UI does -- and must not report that exit as a crash.
 *
 * The fixture answers every build after 300 ms, so the cancel and the
 * start-another-build cases both land while it is running.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { BuildWorkerHost } from '../src/compiler/buildSupervisor';
import type { BuildRequest, BuildResponse } from '../src/common/types';

const SLOW_BUILD = `const { parentPort } = require('node:worker_threads');
parentPort.on('message', message => {
	if (message.type) return;
	setTimeout(() => {
		parentPort.postMessage({ id: message.id, ok: true, success: true, code: 'ok', instructionCount: 1, errors: [], warnings: [], elapsedMs: 1 });
	}, 300);
});
`;

function fixture(name: string, body: string): string {
	const file = path.join(__dirname, name);
	fs.writeFileSync(file, body);
	return file;
}

function buildRequest(): Omit<BuildRequest, 'id'> {
	return {
		uri: 'file:///project/main.mlgc',
		text: 'int main(void) { return 0; }',
		config: {
			profileName: 'default',
			targetVersion: 154.3,
			includePaths: [],
			memoryBlocks: [],
			compilerOptions: {
				array: false,
				constArray: false,
				pointer: false,
				structPointerThreshold: 0,
				stackCheck: '',
				stackUnderflow: '',
				noInline: [],
			},
			idOverrides: {},
			sources: {},
			globalPath: null,
			workspacePath: null,
			problems: [],
		},
	};
}

function settle(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
			setTimeout(tick, 5);
		};
		tick();
	});
}

describe('cancelling a build', () => {
	it('stops the thread, reports nothing, and answers the next build', async () => {
		const results: BuildResponse[] = [];
		const crashes: string[] = [];
		const host = new BuildWorkerHost({
			workerPath: fixture('fixture-slow-build.js', SLOW_BUILD),
			onResult: response => results.push(response),
			onCrash: reason => crashes.push(reason),
		});

		try {
			assert.ok(host.start(buildRequest()) > 0, 'the build was not started');
			await settle(50);
			host.cancel();
			await settle(400);

			assert.equal(results.length, 0, 'a cancelled build produced a result');
			assert.deepEqual(crashes, [], 'terminating the thread was reported as a crash');

			host.start(buildRequest());
			await waitFor(() => results.length === 1, 'the replacement build');
			assert.equal(results[0].code, 'ok');
		} finally {
			await host.dispose();
		}
	});

	it('terminates a running build when another one starts', async () => {
		const results: BuildResponse[] = [];
		const crashes: string[] = [];
		const host = new BuildWorkerHost({
			workerPath: fixture('fixture-slow-build.js', SLOW_BUILD),
			onResult: response => results.push(response),
			onCrash: reason => crashes.push(reason),
		});

		try {
			host.start(buildRequest());
			await settle(50);
			const second = host.start(buildRequest());
			await waitFor(() => results.length === 1, 'the second build');
			await settle(400);

			assert.equal(results.length, 1, 'the superseded build also answered');
			assert.equal(results[0].id, second);
			assert.deepEqual(crashes, []);
		} finally {
			await host.dispose();
		}
	});
});
