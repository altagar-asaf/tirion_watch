export type DiagnosticFact = {
  code: string;
  severity: "info" | "warning" | "error";
  at: string;
};

export interface ClockPort {
  now(): Date;
  setInterval(handler: () => void, intervalMs: number): { dispose(): void };
  setTimeout(handler: () => void, delayMs: number): { dispose(): void };
}

export interface AtomicStoragePort {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SecretStoragePort {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DiagnosticsSinkPort {
  record(fact: DiagnosticFact): void;
}

export interface ConfigProviderPort {
  get<T>(key: string): T | undefined;
}

export type RegisteredSource = {
  sourceId: string;
  sourceKind: string;
  environmentId: string;
};

export interface SourceRegistrationPort {
  list(): Promise<RegisteredSource[]>;
}

export type RepositoryScope = {
  scopeId: string;
  environmentId: string;
  state: "active" | "paused" | "unavailable";
};

export interface RepositoryScopeProviderPort {
  list(): Promise<RepositoryScope[]>;
}

export interface LifecycleHooksPort {
  onStart(handler: () => Promise<void> | void): void;
  onStop(handler: () => Promise<void> | void): void;
}

export type EngineRuntimePorts = {
  clock: ClockPort;
  atomicStorage: AtomicStoragePort;
  secretStorage: SecretStoragePort;
  diagnostics: DiagnosticsSinkPort;
  config: ConfigProviderPort;
  sources: SourceRegistrationPort;
  repositoryScopes: RepositoryScopeProviderPort;
  lifecycle: LifecycleHooksPort;
};

export type EngineHostBoundary = {
  start(): Promise<void>;
  stop(): Promise<void>;
  runtimeKind: "host-boundary";
};

export function createEngineHostBoundary(ports: EngineRuntimePorts): EngineHostBoundary {
  let started = false;
  ports.lifecycle.onStart(() => {
    started = true;
    ports.diagnostics.record({ code: "engine_host_started", severity: "info", at: ports.clock.now().toISOString() });
  });
  ports.lifecycle.onStop(() => {
    started = false;
    ports.diagnostics.record({ code: "engine_host_stopped", severity: "info", at: ports.clock.now().toISOString() });
  });

  return {
    runtimeKind: "host-boundary",
    async start() {
      if (!started) {
        ports.diagnostics.record({ code: "engine_host_start_requested", severity: "info", at: ports.clock.now().toISOString() });
      }
    },
    async stop() {
      if (started) {
        ports.diagnostics.record({ code: "engine_host_stop_requested", severity: "info", at: ports.clock.now().toISOString() });
      }
    }
  };
}

export * from "./telemetryClassification";
export * from "./shadowUsage";
export * from "./executionTreeProjection";
export * from "./modelProviderResolution";
