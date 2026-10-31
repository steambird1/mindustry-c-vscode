/*
 * The supervisor that owns the build worker thread.
 *
 * One build at a time: the optimiser is memory-hungry, and two concurrent
 * builds of a large file will fight for the same cores. Starting a new build
 * cancels the one in flight, which is what a user who hits the button twice
 * means.
 */

import { Worker } from 'node:worker_threads';

import type { BuildRequest, BuildResponse, KnownDocumentsMessage } from '../common/types';

export interface BuildWorkerOptions {
	/** Absolute path of the built worker bundle. */
	workerPath: string;
	/** Called with each finished build. */
	onResult(response: BuildResponse): void;
	/** Called when the worker dies. */
	onCrash?(reason: string): void;
}

export class BuildWorkerHost {
	private worker: Worker | null = null;
	private nextId = 1;
	private inFlight: number | null = null;

	constructor(private readonly options: BuildWorkerOptions) {}

	private knownPaths: Record<string, string> = {};

	/**
	 * Buffers the build may `#include`, so an unsaved header is not read from a
	 * stale copy on disk. Same arrangement as the analyser: the map is handed
	 * over at spawn, and a live thread is told when it changes.
	 */
	setKnownDocuments(documents: Map<string, string>): void {
		this.knownPaths = Object.fromEntries(documents);
		try {
			this.worker?.postMessage({
				type: 'known-documents',
				documents: this.knownPaths,
			} satisfies KnownDocumentsMessage);
		} catch {
			// On its way out; the next `start()` spawns with `knownPaths`.
		}
	}

	/** Start a build, terminating any build already running. */
	start(request: Omit<BuildRequest, 'id'>): number {
		// A running compile cannot be interrupted from inside the thread: the
		// optimiser is synchronous, so a cancel message would only be read after
		// it finished. Terminating the thread is the only real cancellation --
		// the same thing the compiler's browser UI does.
		if (this.inFlight !== null) this.terminate();
		const worker = this.spawn();
		if (!worker) {
			const message = 'The Mindustry-C build worker is unavailable.';
			this.options.onCrash?.(message);
			return -1;
		}
		const id = this.nextId++;
		this.inFlight = id;
		worker.postMessage({ ...request, id } satisfies BuildRequest);
		return id;
	}

	cancel(): void {
		if (this.inFlight === null) return;
		this.inFlight = null;
		this.terminate();
	}

	/**
	 * Stop the thread now.
	 *
	 * `worker` is cleared before `terminate()` resolves, and every handler
	 * compares the instance it belongs to with `this.worker`, so a deliberate
	 * stop cannot be reported as a crash and `spawn()` can start the replacement
	 * while the old thread is still shutting down.
	 */
	private terminate(): void {
		const worker = this.worker;
		this.worker = null;
		if (worker) void worker.terminate();
	}

	private spawn(): Worker | null {
		if (this.worker) return this.worker;
		try {
			const worker = new Worker(this.options.workerPath, {
				workerData: { knownPaths: this.knownPaths },
			});
			worker.on('message', (response: BuildResponse) => {
				if (this.worker !== worker) return;
				if (this.inFlight === null || response.id < this.inFlight) return;
				this.inFlight = null;
				this.options.onResult(response);
			});
			worker.on('error', error => {
				if (this.worker !== worker) return;
				this.died(error.stack ?? error.message);
			});
			worker.on('exit', code => {
				if (this.worker !== worker) return;
				if (code !== 0) this.died(`the build thread exited with code ${code}`);
			});
			this.worker = worker;
			return worker;
		} catch (error) {
			this.options.onCrash?.(error instanceof Error ? error.message : String(error));
			return null;
		}
	}

	private died(reason: string): void {
		this.worker = null;
		this.inFlight = null;
		this.options.onCrash?.(`The Mindustry-C build stopped unexpectedly (${reason}).`);
	}

	async dispose(): Promise<void> {
		this.inFlight = null;
		const worker = this.worker;
		this.worker = null;
		if (worker) await worker.terminate();
	}
}
