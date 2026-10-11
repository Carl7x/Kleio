import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { lock } from 'proper-lockfile';
import { CoreError } from './contracts.ts';

export interface ServiceOwnership {
  /** Canonical path shared by the database and its process lock. */
  readonly databasePath: string;
  assertHeld(): void;
  release(): Promise<void>;
}

/** Acquire before opening the database or recovering its previous executions. */
export async function acquireOwnership(file: string, onLost: (error: CoreError) => void): Promise<ServiceOwnership> {
  const absolute = resolve(file);
  mkdirSync(dirname(absolute), { recursive: true });
  // A new SQLite file does not exist yet; resolve its existing parent instead.
  const databasePath = existsSync(absolute) ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
  let lost = false;
  let released = false;
  let releasePromise: Promise<void> | undefined;
  let unlock: () => Promise<void>;
  try {
    unlock = await lock(databasePath, {
      realpath: false, retries: 0, stale: 30_000, update: 5_000,
      onCompromised: () => {
        lost = true;
        onLost(new CoreError('ownership_lost', '服务独占锁已失效，正在停止执行。', 500));
      },
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ELOCKED')
      throw new CoreError('service_owned', '此数据库已有运行中的服务；第二实例不会恢复或修改它的任务。');
    throw error;
  }
  return {
    databasePath,
    assertHeld() {
      if (lost || released) throw new CoreError('ownership_lost', '服务已不再拥有此数据库的执行权。', 500);
    },
    release() {
      releasePromise ??= (async () => {
        released = true;
        // A compromised lock is no longer ours. Never remove a replacement lock.
        if (!lost) await unlock();
      })();
      return releasePromise;
    },
  };
}
