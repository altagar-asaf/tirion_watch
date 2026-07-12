# Complex Agentic Run Fixtures

`complexChildAgentScenarios.ts` contains metadata-only deterministic replays of
the accepted Codex Desktop three-child and four-child stress runs.

The fixtures start at Tirion's privacy-safe observation contract. They include
opaque run/session lineage, token vectors, activity outcomes, opaque artifact
keys, and expected repository-relative file paths. They intentionally exclude
prompt text, response text, tool arguments/output, command text, file content,
diffs, transcript locations, and absolute paths.

The engine replay protects usage authority selection, internal-session
exclusion, exact child folding, outcome integrity, and token conservation. The
agent replay protects canonical lifecycle ordering, terminal activity, causal
file projection, privacy, and durable delivery behavior.

Native harness payload parsing remains covered by the harness-specific ingress
and classification tests. Add a native schema fixture there whenever a provider
version introduces or changes an accepted field.
