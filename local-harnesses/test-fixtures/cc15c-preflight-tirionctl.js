import { appendFileSync } from "node:fs";

if (process.argv[2] === "status") {
  const target = process.env.TIRION_CC15C_STUB_MUTATE_NORMAL;
  if (target) appendFileSync(target, "x");
  process.stdout.write(`${JSON.stringify({
    health: "healthy",
    runtimeWarmupState: "ready",
    otlp: { port: 4318 }
  })}\n`);
  process.exit(0);
}

process.exit(64);
