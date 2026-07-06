# Security Policy

Tirion is currently a public source preview. Security support covers the `main`
branch and the latest preview tag once tags are published.

## Reporting A Vulnerability

Please do not open public issues for vulnerabilities or privacy bugs.

Use GitHub private vulnerability reporting for this repository. If private
reporting is unavailable, contact the maintainer privately through the GitHub
profile linked from the repository before sharing details publicly.

Do not attach prompt text, response text, source code, raw telemetry, secrets,
logs with absolute paths, private repository names, or webhook payloads from a
real workspace. Use minimal synthetic examples whenever possible.

## Response Expectations

- Acknowledgement target: 3 business days.
- Initial triage target: 7 business days.
- Disclosure: coordinated disclosure after a fix, workaround, or agreed
  disclosure timeline.

## Scope

Security-sensitive areas include local agent control, loopback telemetry ingress,
provider configuration, local storage, diagnostics, support bundles, webhook
delivery, and release artifacts.
