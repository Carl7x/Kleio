import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { RuntimeStore } from '../../packages/runtime/store.ts';

interface Device { id: string; name: string; digest: string; createdAt: string; expiresAt: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ttl = 90 * 24 * 60 * 60 * 1000;

export function localAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap(rows =>
    (rows ?? []).filter(row => row.family === 'IPv4' && !row.internal).map(row => row.address)))];
}

/** Pairing grants a revocable device session, never the runtime administration token. */
export class DeviceSessions {
  private pending: { digest: string; expires: number; attempts: number } | undefined;
  constructor(private readonly store: RuntimeStore) {}
  private all(): Device[] { return this.store.getSetting<Device[]>('pairedDevices', []).filter(d => Date.parse(d.expiresAt) > Date.now()); }
  issue(): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    const expires = Date.now() + 5 * 60_000;
    this.pending = { digest: hash(code), expires, attempts: 0 };
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  consume(code: string): boolean {
    const pending = this.pending;
    if (!pending || pending.expires <= Date.now() || pending.attempts >= 5) { this.pending = undefined; return false; }
    pending.attempts++;
    if (hash(code.replace(/[\s-]/g, '')) !== pending.digest) return false;
    this.pending = undefined;
    return true;
  }
  create(name: string): { token: string; deviceId: string; expiresAt: string } {
    const token = randomBytes(32).toString('base64url');
    const device: Device = { id: randomUUID(), name, digest: hash(token), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttl).toISOString() };
    this.store.setSetting('pairedDevices', [...this.all().slice(-19), device]);
    return { token, deviceId: device.id, expiresAt: device.expiresAt };
  }
  authenticate(authorization: string | undefined): Device | undefined {
    if (!authorization?.startsWith('Bearer ') || authorization.length > 256) return;
    const digest = hash(authorization.slice(7));
    return this.all().find(device => device.digest === digest);
  }
  list(): Omit<Device, 'digest'>[] { return this.all().map(({ digest: _, ...device }) => device); }
  revoke(id: string): void { this.store.setSetting('pairedDevices', this.all().filter(device => device.id !== id)); }
}
