# Security policy

We take security seriously. If you think you've found a vulnerability in capture-sdk, this document tells you how to report it and what to expect from us in response.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.** Public issues are visible to everyone before we have a chance to fix the problem.

Two ways to report:

1. **Preferred — GitHub Security Advisories** (private to YNK):
   https://github.com/surayainc/capture-sdk/security/advisories/new

2. **Email** (use only if GitHub is unavailable to you):
   security@ynkincubator.com

Either channel is monitored by a Tier 0 owner.

## What to include

A useful report has, at minimum:

- A clear description of the vulnerability and its impact.
- Steps to reproduce — be as specific as possible. Sample requests, payloads, or scripts are welcome.
- The affected version(s) of the product, if known.
- Your assessment of the severity (informational / low / medium / high / critical) and the reasoning.
- Any suggested mitigations or patches you've thought of.

If you have a CVE in mind that this matches or is similar to, mention it.

## Our response

We commit to:

- **Acknowledge** receipt within **2 business days**.
- **Triage** and confirm the vulnerability (or explain why we believe it isn't one) within **5 business days**.
- **Patch** confirmed vulnerabilities according to severity:
  - **Critical** (remote code execution, auth bypass, data exfiltration affecting all users): patched within 7 days.
  - **High** (significant data exposure, privilege escalation): patched within 30 days.
  - **Medium** (limited data exposure, requires authenticated access): patched within 90 days.
  - **Low / informational** (defense-in-depth improvements, best-practice gaps): scheduled into the regular roadmap.
- **Communicate** progress to you at each step.
- **Credit** you publicly in the patch release notes (with your permission, and only by the name or handle you specify). If you'd rather remain anonymous, that's fine too.

## Scope

`capture-sdk` is a **published library**, not a hosted service. Scope is the package
and its source, not any deployment.

In scope:

- The `capture-sdk` source in this repository.
- The published npm package [`@surayaorg/capture`](https://www.npmjs.com/package/@surayaorg/capture)
  and its build/release provenance.
- Public APIs and hook signatures the package exposes to consuming applications.
- Anything the package writes to, reads from, or transmits on a consumer's machine
  (credentials, local state, network destinations).

Out of scope:

- Findings from automated scanners without a working proof of concept.
- Vulnerabilities in **applications that consume** this package, unless the package
  itself is what makes them exploitable. Report those against the application.
- Issues in third-party services or registries we depend on (npm, GitHub, Doppler,
  etc.) — please report those to the relevant vendor directly.
- Social engineering of YNK staff or contractors.
- Physical attacks against YNK offices, staff, or infrastructure.
- Denial of service (rate limiting, traffic flooding).
- Issues requiring an already-compromised local machine (malware, MITM via an
  attacker-controlled proxy, etc.).

## Safe harbor

If you make a good-faith effort to comply with this policy when reporting a vulnerability, we will:

- Not pursue legal action against you.
- Treat your activity as authorized testing under applicable computer-misuse laws.
- Work with you to understand and resolve the issue quickly.

Good-faith effort means: you do not exfiltrate or destroy data beyond what is necessary to demonstrate the vulnerability, you do not access other users' data, you do not perform actions that degrade availability for others, and you give us reasonable time to respond before any public disclosure.

## Disclosure policy

We follow a **coordinated disclosure** model. After we've patched the vulnerability:

- We publish a security advisory describing the issue, the fix, and the affected versions.
- We credit the reporter (unless they've asked to remain anonymous).
- We give the reporter at least 7 days' notice before any public disclosure on our part, so they can coordinate any disclosure on theirs.

If a vulnerability is already being actively exploited in the wild, we may shorten this timeline to protect users.

## Questions

For non-vulnerability security questions (general posture, policies, audit logs, compliance), email security@ynkincubator.com.

---

*This policy follows the YNK Engineering Operating Model. YNK's org-wide incident-response process is maintained internally.*
