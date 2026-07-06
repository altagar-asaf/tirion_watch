export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function otelAttributesToRecord(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (Array.isArray(value)) {
    const attributes: Record<string, unknown> = {};
    for (const item of value) {
      if (!isRecord(item) || typeof item.key !== "string") {
        continue;
      }
      attributes[item.key] = unwrapOtelValue(item.value);
    }
    return attributes;
  }

  if (isRecord(value)) {
    return { ...value };
  }

  return {};
}

export function hrTimeToUnixNano(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 2) {
    return undefined;
  }

  const seconds = toNumber(value[0]);
  const nanos = toNumber(value[1]);
  if (seconds == null || nanos == null) {
    return undefined;
  }

  return String(Math.trunc(seconds * 1_000_000_000 + nanos));
}

export function unwrapOtelValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return toNumber(value.intValue) ?? value.intValue;
  if ("doubleValue" in value) return toNumber(value.doubleValue) ?? value.doubleValue;
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("bytesValue" in value) return value.bytesValue;

  if (isRecord(value.kvlistValue)) {
    return otelAttributesToRecord(value.kvlistValue.values);
  }

  if (isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
    return value.arrayValue.values.map(unwrapOtelValue);
  }

  return value;
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

export function unixNanoToIso(value: unknown): string | undefined {
  const numberValue = toNumber(value);
  if (numberValue == null || numberValue <= 0) {
    return undefined;
  }

  const millis = Math.floor(numberValue / 1_000_000);
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function durationMs(startUnixNano?: string, endUnixNano?: string): number | undefined {
  const start = toNumber(startUnixNano);
  const end = toNumber(endUnixNano);
  if (start == null || end == null || end < start) {
    return undefined;
  }
  return Math.round((end - start) / 1_000_000);
}

export function stableRecordKey(value: unknown): string {
  if (!isRecord(value)) {
    return JSON.stringify(value);
  }

  const keys = Object.keys(value).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    normalized[key] = isRecord(value[key]) ? JSON.parse(stableRecordKey(value[key])) : value[key];
  }
  return JSON.stringify(normalized);
}
