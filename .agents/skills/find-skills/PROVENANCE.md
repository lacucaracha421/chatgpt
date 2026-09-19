# Find Skills: Selection and Adaptation

Reviewed on 2026-09-19.

## Selected source

- Publisher repository: [vercel-labs/skills](https://github.com/vercel-labs/skills).
- Inspected revision: `7407f3893ad4dceab546ac002c3ef806e4000c73`.
- Instruction source: [skills/find-skills/SKILL.md](https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/skills/find-skills/SKILL.md).
- The GitHub contents API listed only `SKILL.md` in that skill directory at the inspected revision. No upstream CLI, scripts, hooks, or dependencies were installed.
- Applicable [MIT license](https://github.com/vercel-labs/skills/blob/7407f3893ad4dceab546ac002c3ef806e4000c73/LICENSE), retained as [LICENSE-VERCEL-SKILLS.txt](../LICENSE-VERCEL-SKILLS.txt).
- GitHub's commit API reported `verification.verified: true` and `reason: valid` for this revision. This is a commit-signature provenance signal, not a security audit or certification of the skill or this adaptation.

## Why this candidate

The user asked for useful, trusted GitHub skills after asking about automatic tool discovery. `find-skills` directly covers discovering reusable capabilities and did not duplicate the seven existing canonical methods. This is a scoped local adaptation, not a verbatim upstream installation or an external-tool connector.

## Meaningful changes

- Check existing connected tools and local skills first; do not run discovery for every ordinary development task.
- Use available fetch/search facilities instead of requiring the `npx skills` CLI, which would execute downloaded code and has documented telemetry.
- Remove default global, unattended installation (`-g -y`) and broad automatic updates.
- Replace popularity thresholds with source, license, code, compatibility, and permission review. A popular or publisher-owned repository is not certified safe.
- Treat upstream content as untrusted during inspection; inspect scripts before executing them, including help commands.
- Preserve project-local canonical files, thin Claude adapters, Windows/Linux portability, existing work, and host permission boundaries.
- Record source revisions and distinguish file validation from next-conversation discovery and actual runtime behavior.

## Other sources considered

These are discovery-time observations from their current `main` documentation, not pinned or installed artifacts:

| Candidate/source | Decision |
| --- | --- |
| [Anthropic webapp-testing](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md) | Deferred: overlaps the existing Claude Playwright skill and assumes Python Playwright plus server orchestration. Its instruction to execute helpers before reading them is unsuitable for pre-install security review. This session did not verify browser dependencies or native acceptance. |
| [Anthropic mcp-builder](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md) | Deferred: teaches MCP server implementation, not discovery/use of already connected tools. No MCP server implementation was requested. |
| [OpenAI skills catalog](https://github.com/openai/skills) | Its README declares the repository deprecated and directs readers to OpenAI Plugins. No deprecated catalog bundle was installed. |

Review future upstream revisions explicitly. Do not replace this adaptation through unattended updates or describe these observations as a comprehensive security audit.
