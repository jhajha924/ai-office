import type { Cell, Pod, Seat } from './layout.ts';
import { POD_ORDER, PODS } from './layout.ts';

/**
 * Which pod each group sits at, one allocator per floor of each building. A new group takes
 * the first free pod in POD_ORDER (nearest the door first) and keeps it while
 * it stays; a group that leaves frees its pod for the next newcomer. Groups
 * beyond the floor's pods get none: they are listed in the sidebar only.
 */
export class PodAllocator {
  private bySession = new Map<string, number>();
  private readonly pods: Pod[];
  private readonly order: number[];

  constructor(pods: Pod[] = PODS, order: number[] = POD_ORDER) {
    this.pods = pods;
    this.order = order;
  }

  /** Reconcile with the groups now on this building (in arrival order). */
  update(sessionIds: string[]): void {
    const present = new Set(sessionIds);
    for (const id of [...this.bySession.keys()]) if (!present.has(id)) this.bySession.delete(id);
    const used = new Set(this.bySession.values());
    for (const id of sessionIds) {
      if (this.bySession.has(id)) continue;
      const free = this.order.find((index) => !used.has(index));
      if (free === undefined) continue;
      this.bySession.set(id, free);
      used.add(free);
    }
  }

  podOf(sessionId: string): Pod | undefined {
    const index = this.bySession.get(sessionId);
    return index === undefined ? undefined : this.pods.find((p) => p.index === index);
  }

  /** Sessions on this building without a pod. */
  overflow(sessionIds: string[]): string[] {
    return sessionIds.filter((id) => !this.bySession.has(id));
  }
}

/** Where the n-th actor of a group goes: seats first, then the standing cells. */
export function placeFor(pod: Pod, n: number): (Seat | (Cell & { facing?: undefined })) | undefined {
  if (n < pod.seats.length) return pod.seats[n];
  return pod.standing[n - pod.seats.length];
}
