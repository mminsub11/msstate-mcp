# Security Policy

## Reporting a Vulnerability

If you find a security issue in `msstate-mcp` or the deployed Cloudflare Worker at `https://msstate-policies-mcp.mminsub90.workers.dev`, please report it privately rather than filing a public GitHub issue.

**How to report:**

- **Preferred:** open a [private security advisory](https://github.com/mminsub11/msstate-mcp/security/advisories/new) on GitHub. This keeps the report off public issue trackers until a fix is published.
- **Alternative:** email the maintainer through the email listed on the [GitHub profile](https://github.com/mminsub11), with `[msstate-mcp security]` in the subject line.

**Please include:**

1. A description of the issue and the affected component (stdio MCP server, Cloudflare Worker, npm package, build scripts, or `worker/corpus.json` content).
2. Reproduction steps or proof-of-concept. Mask any tokens or credentials in the report — even if the credential *is* the vulnerability.
3. The version (commit SHA, npm package version, or Worker deploy URL) you observed the issue on.
4. Your assessment of impact (information disclosure, privilege escalation, denial of service, supply chain, etc.).

**Response expectations:**

- Acknowledgement within 7 days.
- Initial triage + severity assessment within 14 days.
- Public disclosure after a fix is available, coordinated with the reporter. Default disclosure window is 90 days from acknowledgement; longer if the fix requires multi-party coordination (e.g., Cloudflare, Anthropic, npm).

## Supported Versions

This project follows simple supported-version rules:

| Component | What's supported |
|---|---|
| **npm package `msstate-policies-mcp`** | The latest published version on npm. Older majors do not receive security backports. Pin to `^x.y.z` to opt into compatible patches automatically. |
| **Claude Code plugin / GitHub `main`** | The `main` branch HEAD. Tagged releases (`v0.x.0` and later) are snapshots; only `main` receives security fixes. |
| **Cloudflare Worker** at `https://msstate-policies-mcp.mminsub90.workers.dev` | Whatever is currently deployed. The Worker is rebuilt from `main` periodically. The deployed version is independent of npm releases. |
| **Project starter zip** (free claude.ai users) | The latest GitHub release asset. Older release assets are not patched. |

## What's in scope

Reportable issues include:

- Code execution, supply-chain attacks (typosquatting, malicious dependencies), or compromised release artifacts.
- Information disclosure beyond what `policies.msstate.edu` already publishes (e.g., server-side state, internal paths, request logs leaking through error messages).
- Authentication/authorization bypass on the deployed Worker (currently no auth — abuse of the open endpoint is a known limitation, not a vulnerability).
- Denial of service against the Worker that exceeds Cloudflare's standard DDoS protection.
- Prompt injection via planted content in `worker/corpus.json` if the build pipeline can be subverted.
- Misuse of the corpus rule (claims that the server returns content NOT from `policies.msstate.edu`).

## What's NOT in scope

These are known limitations, not vulnerabilities:

- The Cloudflare Worker is intentionally **unauthenticated** so claude.ai's connector can reach it. Anyone on the internet can call it. Rate limiting beyond Cloudflare's free-tier defaults is not configured.
- The Worker corpus is a **periodic snapshot**, not live data. The `retrievedAt` timestamp in responses reflects build time, not request time. This is documented in [`README.md`](README.md) and [`docs/BUILD.md`](docs/BUILD.md).
- The published npm package commits `dist/index.js` and `dist/embeddings.json` — bundled artifacts that the plugin path depends on. These are reproducible from `src/` via `npm run build` (CI verifies via `git diff --exit-code dist/`), but they're not signed. If you need verified provenance, prefer the `npm publish --provenance` path documented in [`docs/BUILD.md`](docs/BUILD.md).
- Issues in `policies.msstate.edu` itself (MSU's site) are out of scope here. Report those to MSU directly.

## Out of scope: client-side circumvention

Several abuse classes that come up in MCP threat-modelling are **explicitly outside this server's threat model**, because the trust principal is the user / their LLM / their machine — not us. The maintainer disclaims responsibility for the following:

- A user downloads the published npm bundle, edits `dist/index.js` (or runs a fork) locally, and serves modified "policies" to their own LLM client. The user owns their local execution; we have no enforcement story across that boundary, and no claim of authority over what runs there.
- A user instructs the LLM to ignore the tool description's rules — verbatim quotation, citation, refusal-on-low-confidence — and to "just answer from training data." The tool description is a *suggestion* to the model; the model and its operator are the trust principals here. Prompt-level circumvention cannot be prevented from the server, and pretending it can would be a worse failure mode than disclaiming it.
- A user runs `npx msstate-policies-mcp` and points it at a forked corpus, a non-MSU mirror, or a hand-edited local copy. Same boundary — local execution, local trust. The corpus rule binds the *maintainer* of this repo, not consumers of the published artifact.
- The LLM hallucinates an answer despite the tool returning empty results, refusing on a low-confidence gate, or surfacing the in-payload `disclaimer`. Those signals are best-effort hints to the model, not enforcement; an LLM that ignores them is not within our control.
- Indirect prompt injection embedded inside MSU policy PDFs themselves (e.g. an attacker who got something published into an OP). The defense lives upstream at MSU's policy authoring/review process — we faithfully relay the published text.

If you find a way to violate the server-side corpus rule (i.e. make the *server itself* return content that does NOT come from `policies.msstate.edu`), that is in scope and falls under the reporting flow above.

## Trust model

The corpus rule (see [`CLAUDE.md`](CLAUDE.md) and [`docs/BUILD.md`](docs/BUILD.md)) is the load-bearing security claim: every fact this server returns must trace back to an HTTP fetch of `policies.msstate.edu`. If you find a way to make the server return content that does NOT come from that source, that is a critical vulnerability and falls under the reporting flow above.
