/*
 * Reading and writing files for the configuration manager.
 *
 * A thin wrapper rather than direct `fs` calls, so the merge logic in
 * src/config/manager.ts can be tested against an in-memory filesystem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FileSystem } from './manager';

export const nodeFileSystem: FileSystem = {
	read(target) {
		try {
			return fs.readFileSync(target, 'utf8');
		} catch {
			return null;
		}
	},
	write(target, contents) {
		fs.writeFileSync(target, contents, 'utf8');
	},
	exists(target) {
		return fs.existsSync(target);
	},
	mkdirp(target) {
		fs.mkdirSync(target, { recursive: true });
	},
	join: (...parts) => path.join(...parts),
	dirname: target => path.dirname(target),
};

/** An in-memory filesystem, for tests and for the extension's own defaults. */
export function memoryFileSystem(files: Record<string, string> = {}): FileSystem & {
	files: Map<string, string>;
} {
	const store = new Map(Object.entries(files));
	const normalise = (target: string) => target.replace(/\\/g, '/');
	return {
		files: store,
		read(target) {
			return store.get(normalise(target)) ?? null;
		},
		write(target, contents) {
			store.set(normalise(target), contents);
		},
		exists(target) {
			return store.has(normalise(target));
		},
		mkdirp() {
			/* directories are implied */
		},
		join: (...parts) => normalise(parts.join('/')),
		dirname: target => {
			const normalised = normalise(target);
			const index = normalised.lastIndexOf('/');
			return index <= 0 ? '/' : normalised.slice(0, index);
		},
	};
}
