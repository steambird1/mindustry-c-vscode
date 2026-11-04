/*
 * Memory caps for the compiler workers.
 *
 * A JavaScript heap OOM inside a worker thread is fatal to the whole process:
 * the worker and the editor (or the language server) share one address space,
 * and `terminate()` never gets a chance to run. `resourceLimits` makes V8 stop
 * the worker with `ERR_WORKER_OUT_OF_MEMORY` while the parent stays alive; the
 * supervisors already turn a dead worker into a crash report.
 *
 * 512 MB is far above normal analysis and build use. A runaway compiler -- an
 * exponential initializer, a recursive type walk -- should cost the worker, not
 * the editor.
 */

import type { ResourceLimits } from 'node:worker_threads';

export const COMPILER_WORKER_RESOURCE_LIMITS: ResourceLimits = {
	maxOldGenerationSizeMb: 512,
	maxYoungGenerationSizeMb: 64,
	// The compiler recurses through types and initializers; 8 MB keeps a deep
	// but legitimate tree from turning into a stack-overflow diagnostic.
	stackSizeMb: 8,
};
