// One host-wide concurrency semaphore shared by the dispatcher AND the scheduler
// (defends against e.g. a rate-limit-reset thundering herd of jobs).
const MAX = Number(process.env.SENTINEL_MAX_CONCURRENT ?? 4);
let active = 0;
const waiters: Array<() => void> = [];

export function acquire(): Promise<void> {
  if (active < MAX) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve)); // slot handed over on release
}

export function release(): void {
  const next = waiters.shift();
  if (next) next(); // hand the slot directly; active count unchanged
  else active = Math.max(0, active - 1);
}

export function activeCount(): number {
  return active;
}
