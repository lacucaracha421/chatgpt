# Lakomics Project Skills

This is the canonical, project-local skill collection for Lakomics. It contains scoped adaptations, not an installation of the full Ponytail, Superpowers, or UI/UX Pro Max plugin runtimes. `AGENTS.md` remains the common policy authority, subject to host instructions and the current request.

## Available methods

| Skill | Use when | Do not treat it as |
| --- | --- | --- |
| [find-skills](find-skills/SKILL.md) | Finding and evaluating GitHub skills for a requested capability extension | Safety certification, automatic global installation, or a way to grant unavailable tools |
| [ponytail](ponytail/SKILL.md) | Implementing or refactoring within a defined scope | Permission to omit requirements, safeguards, or necessary tests |
| [ponytail-review](ponytail-review/SKILL.md) | Reviewing a requested diff for unnecessary complexity | A correctness/security review or permission to edit |
| [systematic-debugging](systematic-debugging/SKILL.md) | Tracing a nontrivial failure before fixing it | A requirement to instrument every layer or modify production data |
| [verification-before-completion](verification-before-completion/SKILL.md) | Matching claims to inspected, valid evidence | A requirement to rerun every check or claim unavailable native acceptance |
| [subagent-driven-development](subagent-driven-development/SKILL.md) | Coordinating substantive independent tasks | Automatic worktrees, commits, recursive delegation, or model routing |
| [lakomics-development](lakomics-development/SKILL.md) | Locating component contracts, references, and checks | A replacement for current code, accepted ADRs, or product documentation |
| [ui-ux-pro-max](ui-ux-pro-max/SKILL.md) | Designing, implementing, or reviewing Lakomics UI/UX, accessibility, interaction, and visual polish | Permission to replace the product design system, install UI frameworks, or edit during a review |

## Loading and maintenance

- Zed project skills use `.agents/skills/<name>/SKILL.md`. Start a new conversation after installation and confirm that the eight names appear in the agent's available skill catalog. Files on disk and actual runtime activation are different evidence.
- Claude Code discovery adapters live at `.claude/skills/<name>/SKILL.md`. Each links to its canonical instruction file; the host must load that file to use the method. If a host also discovers `.agents/skills/`, these adapters are aliases, not additional workflows.
- Paths inside a skill's Markdown links resolve relative to that skill. Paths explicitly described as repository paths resolve from the checkout root.
- The existing scoped `.claude/skills/using-superpowers/SKILL.md` selects methods without the upstream always-on workflow chain; it is invoked on demand, not imported by `CLAUDE.md`. Other pre-existing Claude skills and supporting resources are not removed or automatically activated by this installation.
- UI/UX Pro Max reuses its pre-existing `.claude/skills/ui-ux-pro-max/{data,references,scripts}/` for optional local lookup; its canonical instructions live here and its Claude entry point is now an adapter. No resource refresh or duplicate corpus is included. The separate pre-existing `web-design-guidelines` skill is unchanged.
- Edit the canonical file. Keep adapter names and descriptions aligned; do not copy the full body into another directory. Plain files and relative links avoid Windows symlink requirements.
- No lifecycle hooks, global configuration, dependency installation, telemetry, mode-state files, or provider credentials are added. This collection does not select the model used by a subagent.
- Review upstream changes before porting them. Do not overwrite local permission, safety, portability, or evidence adaptations with an automatic update.

## Provenance

Reviewed and adapted on 2026-09-19:

- Ponytail: [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156), inspected `main` reference `e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156`. Sources: `skills/ponytail/SKILL.md` and `skills/ponytail-review/SKILL.md`. Copyright notice and MIT terms: [LICENSE-PONYTAIL.txt](LICENSE-PONYTAIL.txt).
- Superpowers: [obra/superpowers](https://github.com/obra/superpowers/tree/5bf4e78011075bcfc0dc295f0724994cd123ee71), inspected `main` reference `5bf4e78011075bcfc0dc295f0724994cd123ee71`. Sources: `skills/systematic-debugging/SKILL.md`, `skills/verification-before-completion/SKILL.md`, and `skills/subagent-driven-development/SKILL.md`. Copyright notice and MIT terms: [LICENSE-SUPERPOWERS.txt](LICENSE-SUPERPOWERS.txt).
- Debugging and verification preserve the repository's existing adaptations: evidence reuse, read-only boundaries, narrowly scoped instrumentation, preservation of existing implementations, and explicit native/device gaps.
- Find Skills: [vercel-labs/skills](https://github.com/vercel-labs/skills/tree/7407f3893ad4dceab546ac002c3ef806e4000c73), inspected revision `7407f3893ad4dceab546ac002c3ef806e4000c73`. Source: `skills/find-skills/SKILL.md`. See [selection and adaptation notes](find-skills/PROVENANCE.md) and [MIT terms](LICENSE-VERCEL-SKILLS.txt). This is an instruction-only discovery adaptation, not installation of the Skills CLI or a security certification.
- `lakomics-development` is project-specific guidance derived from repository instructions and documentation, not an upstream plugin.
- UI/UX Pro Max: [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/de5f12b400775997d213524ef02a7c7d2746806f), inspected `main` reference `de5f12b400775997d213524ef02a7c7d2746806f`. Adapted instruction source: `.claude/skills/ui-ux-pro-max/SKILL.md`; existing local resources are retained, not asserted to match that revision. See [candidate selection and adaptation notes](ui-ux-pro-max/PROVENANCE.md) and [MIT terms](LICENSE-UI-UX-PRO-MAX.txt).

These references record provenance, not a guarantee of benchmark results on Astra, Opus, or Lakomics. The adaptations intentionally remove line-count targets, fixed reporting limits, automatic Git workflows, mandatory review loops, and repeated verification rituals.
