import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Claim, Episode, MemoryData, Message, Thread } from './types.js';

/**
 * A single JSON file. Deliberately boring:
 * - one user, a few thousand records at most, so everything fits in memory;
 * - `npm install && npm run dev` works everywhere (no native SQLite build);
 * - the file is human-readable, so a reviewer can open data/memory.json.
 * Writes are serialised through a promise chain and done atomically
 * (write temp file, then rename) so a crash cannot corrupt memory.
 */
export class MemoryStore {
  private data: MemoryData = { version: 1, threads: [], messages: [], episodes: [], claims: [] };
  private writing: Promise<void> = Promise.resolve();

  /** `file = null` gives a purely in-memory store (tests). */
  constructor(private readonly file: string | null) {}

  async load(): Promise<this> {
    if (this.file && existsSync(this.file)) {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<MemoryData>;
      this.data = {
        version: 1,
        threads: parsed.threads ?? [],
        messages: parsed.messages ?? [],
        episodes: parsed.episodes ?? [],
        claims: parsed.claims ?? [],
      };
    }
    return this;
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    const snapshot = JSON.stringify(this.data, null, 1);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, file);
    });
    return this.writing;
  }

  static id(): string {
    return randomUUID().slice(0, 8);
  }

  // ---- threads -------------------------------------------------------------
  createThread(title: string, at: string): Thread {
    const t: Thread = { id: MemoryStore.id(), title: title.slice(0, 80), createdAt: at, updatedAt: at };
    this.data.threads.push(t);
    void this.persist();
    return t;
  }
  getThread(id: string): Thread | undefined {
    return this.data.threads.find((t) => t.id === id);
  }
  listThreads(): Thread[] {
    return [...this.data.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ---- messages ------------------------------------------------------------
  addMessage(m: Omit<Message, 'id'>): Message {
    const msg: Message = { id: MemoryStore.id(), ...m };
    this.data.messages.push(msg);
    const t = this.getThread(m.threadId);
    if (t && m.createdAt > t.updatedAt) t.updatedAt = m.createdAt;
    void this.persist();
    return msg;
  }
  threadMessages(threadId: string): Message[] {
    return this.data.messages.filter((m) => m.threadId === threadId);
  }
  getMessage(id: string): Message | undefined {
    return this.data.messages.find((m) => m.id === id);
  }

  // ---- episodes ------------------------------------------------------------
  addEpisode(e: Omit<Episode, 'id'>): Episode {
    const ep: Episode = { id: MemoryStore.id(), ...e };
    this.data.episodes.push(ep);
    void this.persist();
    return ep;
  }
  updateEpisode(id: string, patch: Partial<Episode>): void {
    const ep = this.data.episodes.find((e) => e.id === id);
    if (ep) Object.assign(ep, patch);
    void this.persist();
  }
  episodes(): readonly Episode[] {
    return this.data.episodes;
  }
  getEpisode(id: string): Episode | undefined {
    return this.data.episodes.find((e) => e.id === id);
  }

  // ---- claims --------------------------------------------------------------
  addClaims(claims: Omit<Claim, 'id'>[]): Claim[] {
    const added = claims.map((c) => ({ id: MemoryStore.id(), ...c }));
    this.data.claims.push(...added);
    void this.persist();
    return added;
  }
  claimsForEpisode(episodeId: string): Claim[] {
    return this.data.claims.filter((c) => c.episodeId === episodeId);
  }
  allClaims(): readonly Claim[] {
    return this.data.claims;
  }
  /** The newest re-check of a claim (following the lineage), or the claim itself. */
  latestVersion(claim: Claim): Claim {
    let current = claim;
    for (;;) {
      const next = this.data.claims
        .filter((c) => c.previousClaimId === current.id)
        .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
      if (!next) return current;
      current = next;
    }
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  reset(): Promise<void> {
    this.data = { version: 1, threads: [], messages: [], episodes: [], claims: [] };
    return this.persist();
  }
}
