import { Injectable } from '@nestjs/common';

/** Paths currently being moved/deleted by the API outside a transaction; the indexer skips them. */
@Injectable()
export class BusyPaths {
  private readonly busy = new Map<string, number>();

  add(userId: string, rel: string): () => void {
    const key = `${userId}\u0000${rel}`;
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.busy.get(key) ?? 1) - 1;
      if (n <= 0) this.busy.delete(key); else this.busy.set(key, n);
    };
  }

  covers(userId: string, rel: string): boolean {
    for (const key of this.busy.keys()) {
      const [uid, p] = key.split('\u0000');
      if (uid === userId && (rel === p || rel.startsWith(p + '/'))) return true;
    }
    return false;
  }
}
