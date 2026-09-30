/*
 * The supervisor that owns the build worker thread.
 *
 * One build at a time: the optimiser is memory-hungry, and two concurrent
 * builds of a large file will fight for the same cores. Starting a new build
 * cancels the one in flight, which is what a user who hits the button twice
 * means.
 */

import { Worker } from 'node:worker_threads';

import type { BuildRequest, BuildResponse } from '../common/types';

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

	setKnownDocuments(documents: Map<string, string>): void {
		this.knownPaths = Object.fromEntries(documents);
		this.spawn();
	}

	/** Start a build, cancelling any build already running. */
	start(request: Omit<BuildRequest, 'id'>): number {
		const worker = this.spawn();
		if (!worker) {
			const message = 'The Mindustry-C build worker is unavailable.';
			this.options.onCrash?.(message);
			return -1;
		}
		if (this.inFlight !== null) worker.postMessage({ type: 'cancel', id: this.inFlight });
		const id = this.nextId++;
		this.inFlight = id;
		worker.postMessage({ ...request, id } satisfies BuildRequest);
		return id;
	}

	cancel(): void {
		if (this.inFlight === null || !this.worker) return;
		this.worker.postMessage({ type: 'cancel', id: this.inFlight });
		this.inFlight = null;
	}

	private spawn(): Worker | null {
		if (this.worker) return this.worker;
		try {
			const worker = new Worker(this.options.workerPath, {
				workerData: { knownPaths: this.knownPaths },
			});
			worker.on('message', (response: BuildResponse) => {
				if (this.inFlight === null || response.id < this.inFlight) return;
				this.inFlight = null;
				this.options.onResult(response);
			});
			worker.on('error', error => this.died(error.stack ?? error.message));
			worker.on('exit', code => {
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
		const worker = this.worker;
		this.worker = null;
		this.inFlight = null;
		if (worker) await worker.terminate();
	}
}
