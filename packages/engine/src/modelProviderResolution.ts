import type { ModelProviderBasisV1, ModelProviderV1 } from "@tirion/agent-contract";

export const MODEL_PROVIDER_CLASSIFICATION_VERSION = "model-provider-rules-2026-06-15";

const KNOWN_PROVIDERS = new Set<ModelProviderV1>([
  "anthropic",
  "openai",
  "google",
  "microsoft",
  "github",
  "cursor",
  "unknown"
]);

export type ModelProviderResolution = {
  modelProvider: ModelProviderV1;
  modelProviderBasis: ModelProviderBasisV1;
  modelProviderClassificationVersion: string;
};

export function resolveModelProvider(input: {
  model?: string;
  reportedProvider?: string;
}): ModelProviderResolution {
  const reported = normalizeKnownProvider(input.reportedProvider);
  const inferred = inferModelProvider(input.model);
  if (reported && reported !== "unknown") {
    if (inferred && inferred !== reported) {
      if (reported === "github") {
        return resolution(inferred, "model_name_rule");
      }
      return resolution("unknown", "conflict");
    }
    return resolution(reported, "telemetry_reported");
  }
  return inferred ? resolution(inferred, "model_name_rule") : resolution("unknown", "unknown");
}

function normalizeKnownProvider(value?: string): ModelProviderV1 | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const aliases: Record<string, ModelProviderV1> = {
    "azure-openai": "openai",
    "google-ai": "google",
    "google-vertex-ai": "google"
  };
  const candidate = aliases[normalized] ?? normalized;
  return KNOWN_PROVIDERS.has(candidate as ModelProviderV1) ? candidate as ModelProviderV1 : undefined;
}

function inferModelProvider(model?: string): Exclude<ModelProviderV1, "unknown"> | undefined {
  if (!model) {
    return undefined;
  }
  const normalized = model.trim().toLowerCase();
  if (/^(?:anthropic[./:-])?claude(?:[./:-]|$)/.test(normalized)) return "anthropic";
  if (/^(?:google[./:-])?gemini(?:[./:-]|$)/.test(normalized)) return "google";
  if (/^(?:openai[./:-])?(?:gpt(?:[ ./:-]|$)|o[1345](?:[./:-]|$)|chat-latest$)/.test(normalized)) return "openai";
  if (/^(?:microsoft[./:-])?mai-code(?:[./:-]|$)/.test(normalized)) return "microsoft";
  if (/^(?:github[./:-])?raptor(?:[./:-]|$)/.test(normalized)) return "github";
  if (/^(?:cursor[./:-])?(?:auto|composer)(?:[ ./:-]|$)/.test(normalized)) return "cursor";
  return undefined;
}

function resolution(modelProvider: ModelProviderV1, modelProviderBasis: ModelProviderBasisV1): ModelProviderResolution {
  return {
    modelProvider,
    modelProviderBasis,
    modelProviderClassificationVersion: MODEL_PROVIDER_CLASSIFICATION_VERSION
  };
}
