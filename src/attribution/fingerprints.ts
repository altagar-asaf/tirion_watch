import { createHmac, randomBytes } from "node:crypto";

export const ATTRIBUTION_HMAC_SECRET_KEY = "tirion.attribution.hmacSalt";

export class AttributionHasher {
  constructor(private readonly salt: string) {}

  fingerprint(value: string): string {
    return createHmac("sha256", this.salt).update(value).digest("hex");
  }

  repoKey(repoRoot: string, gitCommonDir: string): string {
    return this.fingerprint(`repo:${normalizeIdentifier(repoRoot)}:${normalizeIdentifier(gitCommonDir)}`);
  }

  artifactKey(repoKey: string, artifactIdentifier: string): string {
    return this.fingerprint(`artifact:${repoKey}:${normalizeIdentifier(artifactIdentifier)}`);
  }

  blobKey(value: string): string {
    return this.fingerprint(`blob:${value}`);
  }
}

export function createAttributionSalt(): string {
  return randomBytes(32).toString("base64");
}

function normalizeIdentifier(value: string): string {
  return value.replace(/\\/g, "/").trim().toLowerCase();
}
