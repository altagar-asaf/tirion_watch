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

  enqueue(key: RuntimeWorkKey, work: () => Promise<void>): void {
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

  async drainKey(key: RuntimeWorkKey): Promise<void> {
    const state = this.states.get(key);
    if (!state || !state.running) {
      return;
    }
    await new Promise<void>((resolve) => {
      state.idleResolvers.push(resolve);
    });
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
