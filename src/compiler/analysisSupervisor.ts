/*
 * The supervisor that owns the analysis worker thread.
 *
 * Responsibilities, in order of importance:
 *
 *  1. Never block the caller. A crash is reported as one diagnostic on the
 *     document rather than as a silent loss of features.
 *  2. Never leak work. Only the newest request per document matters, so a burst
 *     of keystrokes collapses: results for superseded ids are dropped instead of
 *     being published over newer ones.
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';

import type { AnalysisRequest, AnalysisResponse } from '../common/types';

export interface AnalysisWorkerOptions {
	/** Absolute path of the built worker bundle. */
	workerPath: string;
	/** Called for every completed analysis. */
	onResult(response: AnalysisResponse): void;
	/** Called when the worker dies, with the reason. */
	onCrash?(reason: string): void;
	/** Debounce window applied before a request is sent. */
	debounceMs?: number;
}

export class AnalysisWorkerHost {
	private worker: Worker | null = null;
	private readonly latest = new Map<string, number>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private nextId = 1;
	private crashes = 0;

	constructor(private readonly options: AnalysisWorkerOptions) {}

	private knownPaths: Record<string, string> = {};

	/**
	 * Documents the worker should serve from memory rather than from disk: the
	 * editor holds unsaved buffers, and a header that exists only in the editor
	 * must still resolve.
	 */
	setKnownDocuments(documents: Map<string, string>): void {
		this.knownPaths = Object.fromEntries(documents);
		this.spawn();
	}

	/**
	 * Queue an analysis, returning the id it will be answered with. Requests for
	 * the same document inside the debounce window replace one another, so typing
	 * does not queue a hundred runs.
	 */
	analyse(request: Omit<AnalysisRequest, 'id'>): number {
		const uri = request.uri;
		const existing = this.timers.get(uri);
		if (existing) clearTimeout(existing);

		const id = this.nextId++;
		this.latest.set(uri, id);

		const timer = setTimeout(() => {
			this.timers.delete(uri);
			void this.send({ ...request, id });
		}, this.options.debounceMs ?? 0);
		this.timers.set(uri, timer);

		return id;
	}

	private async send(request: AnalysisRequest): Promise<void> {
		// Superseded while queued: the newest request already covers it.
		if (this.latest.get(request.uri) !== request.id) return;
		const worker = this.spawn();
		if (!worker) {
			this.fail(request.id, request.uri, 'The Mindustry-C analyser is unavailable.');
			return;
		}
		worker.postMessage(request);
	}

	private spawn(): Worker | null {
		if (this.worker) return this.worker;
		try {
			const worker = new Worker(this.options.workerPath, {
				workerData: { knownPaths: this.knownPaths },
			});
			worker.on('message', (response: AnalysisResponse) => this.receive(response));
			worker.on('error', error => this.died(error.stack ?? error.message));
			worker.on('exit', code => {
				if (code !== 0) this.died(`the analyser thread exited with code ${code}`);
			});
			this.worker = worker;
			return worker;
		} catch (error) {
			this.options.onCrash?.(error instanceof Error ? error.message : String(error));
			return null;
		}
	}

	private receive(response: AnalysisResponse): void {
		// A result older than what we are waiting for is dropped, so a slow run
		// cannot overwrite a newer one.
		if (this.latest.get(response.uri) !== response.id) return;
		this.options.onResult(response);
	}

	/** Report everything in flight as failed, then start a fresh thread. */
	private died(reason: string): void {
		this.worker = null;
		this.crashes++;
		const message = `The Mindustry-C analyser stopped unexpectedly (${reason}).`;
		this.options.onCrash?.(message);
		this.spawn();
	}

	private fail(id: number, uri: string, message: string): void {
		this.options.onResult({
			id,
			uri,
			diagnostics: [{ severity: 'error', message }],
			index: null,
			fatal: message,
		});
	}

	get crashCount(): number {
		return this.crashes;
	}

	async dispose(): Promise<void> {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		const worker = this.worker;
		this.worker = null;
		if (worker) await worker.terminate();
	}
}

/** Resolve the worker bundle next to the server bundle. */
export function defaultWorkerPath(serverDir: string): string {
	return path.join(serverDir, 'analysisWorker.js');
}
