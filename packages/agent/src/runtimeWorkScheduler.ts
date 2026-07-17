export type RuntimeWorkKey =
  | "usage_projection"
  | "diagnostics_refresh"
  | "repository_scan"
  | "webhook_retry"
  | (string & {});

type RuntimeWorkState = {
  running: boolean;
  requested: boolean;
  work?: () => Promise<void>;
  idleResolvers: Array<() => void>;
};

export class RuntimeWorkScheduler {
  private readonly states = new Map<RuntimeWorkKey, RuntimeWorkState>();
  private generation = 0;

  enqueue(key: RuntimeWorkKey, work: () => Promise<void>): void {
    this.generation += 1;
    const state = this.stateFor(key);
    state.work = work;
    if (state.running) {
      state.requested = true;
      return;
    }
    state.running = true;
    void this.run(key, state);
  }

  async drain(): Promise<void> {
    await Promise.all([...this.states.keys()].map((key) => this.drainKey(key)));
  }

  /**
   * Drains a stable fixed point rather than only the keys present in the
   * first snapshot.  Projection work routinely schedules another lane after
   * persisting its result, so a pre-stop caller must not mistake that first
   * snapshot for quiescence.  The caller supplies a finite round limit and
   * can fail closed if producers keep adding work.
   */
  async drainToFixedPoint(maxRounds = 64): Promise<boolean> {
    if (!Number.isSafeInteger(maxRounds) || maxRounds <= 0) {
      return false;
    }
    for (let round = 0; round < maxRounds; round += 1) {
      const generation = this.generation;
      await this.drain();
      // Let promise continuations which enqueue a new lane run before the
      // stable-generation check.  Timer/event-loop work still causes another
      // caller round, never an unbounded synchronous loop here.
      await Promise.resolve();
      if (generation === this.generation && this.isIdle()) {
        return true;
      }
    }
    return false;
  }

  async drainKey(key: RuntimeWorkKey): Promise<void> {
    const state = this.states.get(key);
    if (!state || !state.running) {
      return;
    }
    await new Promise<void>((resolve) => {
      state.idleResolvers.push(resolve);
    });
  }

  isIdle(): boolean {
    return [...this.states.values()].every((state) => !state.running);
  }

  workGeneration(): number {
    return this.generation;
  }

  private async run(key: RuntimeWorkKey, state: RuntimeWorkState): Promise<void> {
    try {
      do {
        state.requested = false;
        const work = state.work;
        if (!work) {
          return;
        }
        await work();
      } while (state.requested);
    } catch {
      // Background work should fail closed to diagnostics at the call site without
      // breaking the scheduler lane.
    } finally {
      if (!state.requested) {
        state.running = false;
        const resolvers = state.idleResolvers.splice(0);
        for (const resolve of resolvers) {
          resolve();
        }
        if (!state.work) {
          this.states.delete(key);
        }
        return;
      }
      void this.run(key, state);
    }
  }

  private stateFor(key: RuntimeWorkKey): RuntimeWorkState {
    let state = this.states.get(key);
    if (!state) {
      state = { running: false, requested: false, idleResolvers: [] };
      this.states.set(key, state);
    }
    return state;
  }
}
