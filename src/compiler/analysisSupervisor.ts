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
	/**
	 * Requests posted to a thread and not yet answered, as id -> document uri.
	 *
	 * A request still sitting in its debounce timer is deliberately not here:
	 * it has not been posted, so whatever thread exists next will take it.
	 */
	private readonly inFlight = new Map<number, string>();
	private nextId = 1;
	private crashes = 0;
	private disposed = false;

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
		this.inFlight.set(request.id, request.uri);
	}

	private spawn(): Worker | null {
		// Everything that creates a thread funnels through here, so refusing
		// after a dispose is what stops one being created during teardown: the
		// `exit` handler of the thread being terminated still fires, and it
		// fires with a non-zero code.
		if (this.disposed) return null;
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
		this.inFlight.delete(response.id);
		// A result older than what we are waiting for is dropped, so a slow run
		// cannot overwrite a newer one.
		if (this.latest.get(response.uri) !== response.id) return;
		this.options.onResult(response);
	}

	/**
	 * Report everything in flight as failed, then forget the thread.
	 *
	 * Forgetting rather than respawning is deliberate: `spawn()` runs on the
	 * next request, so nothing has to be started here -- and a thread that died
	 * because the bundle on disk is broken would otherwise be started again,
	 * and again, with no request waiting for it.
	 *
	 * Failing the in-flight requests is the other half. A request still in its
	 * debounce timer is left alone: it has not been posted, and the next thread
	 * will take it. One already posted will never be answered, and without this
	 * the document it belongs to keeps the previous run's diagnostics with
	 * nothing to say they are no longer current -- the failure would appear
	 * only in the output channel, and the file would look checked.
	 */
	private died(reason: string): void {
		// Shutting down terminates the thread, and that fires an exit handler
		// with a non-zero code: reporting it would blame a crash for the one
		// thing that went right.
		if (this.disposed) return;
		this.worker = null;
		this.crashes++;
		const message = `The Mindustry-C analyser stopped unexpectedly (${reason}).`;
		this.options.onCrash?.(message);
		this.failInFlight(message);
	}

	/** Answer each request the dead thread took with it, and no others. */
	private failInFlight(message: string): void {
		const lost = [...this.inFlight];
		this.inFlight.clear();
		for (const [id, uri] of lost) {
			// Superseded while in flight: a newer request for this document is
			// still coming and will speak for itself. The same rule `receive`
			// applies to a late result, applied here to a lost one.
			if (this.latest.get(uri) === id) this.fail(id, uri, message);
		}
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
		// Before anything else, so the exit handler of the thread being
		// terminated finds the supervisor already closed rather than reaching
		// for a new one.
		this.disposed = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.inFlight.clear();
		const worker = this.worker;
		this.worker = null;
		if (worker) await worker.terminate();
	}
}

/** Resolve the worker bundle next to the server bundle. */
export function defaultWorkerPath(serverDir: string): string {
	return path.join(serverDir, 'analysisWorker.js');
}
