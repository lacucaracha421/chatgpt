---
name: brainstorming
description: "Explore unresolved product or architecture choices when the user requests design work or ambiguity would materially affect implementation. Not a prerequisite for clear, authorized changes."
---

# Brainstorming Ideas Into Designs

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

## Scope and approval

Use the smallest process that resolves the actual uncertainty. `AGENTS.md` owns authorization, documentation, and verification. Existing approval of a clear task or design is sufficient; do not repeat an interview or require a new approval before every implementation step.

### Three paths

- **Spike:** Investigate a feasibility question with a bounded probe. A read-only question does not authorize code or data writes. State material assumptions, perform only authorized experiments, and report the result without silently shipping exploratory code.
- **Bounded:** Inspect the existing flow, resolve only consequential unknowns, and proceed with the requested implementation. A short approach in chat is enough; no mandatory spec or plan document.
- **Architectural:** Identify affected contracts, compare useful alternatives, and surface decisions that materially change scope or risk. Preserve approved choices. A written design/plan is appropriate when requested or needed for an in-scope multi-session handoff, not automatically for every change.

Reassess scope when evidence reveals hidden complexity. Continue independent authorized work; pause only the portion that needs a new decision or permission. Do not escalate merely because a workflow checklist exists.

### Working checklist

1. Inspect the relevant code, current docs, and task state.
2. Identify which decisions are unresolved and cannot be answered from that evidence.
3. Resolve consequential questions together; batch related questions rather than enforcing one question per turn.
4. Record the selected approach in the existing task context. Persist a document only when warranted under the repository rules.
5. Implement when authorized, using risk-based verification and still-valid evidence. Otherwise deliver the requested design or findings.

## The Process

The guidance below is a toolkit for unresolved design work, not a mandatory sequence for bounded implementation. Read only the parts needed for the current decision.

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent subsystems (e.g., "build a platform with chat, file storage, billing, and analytics"), flag this immediately. Don't spend questions refining details of a project that needs to be decomposed first.
- If the project is too large for a single spec, help the user decompose into sub-projects: what are the independent pieces, how do they relate, what order should they be built? Then resolve the first relevant sub-project. Do not create a separate spec/plan cycle for every sub-project unless it genuinely needs one.
- Ask only questions not already resolved by the request or repository evidence
- Prefer multiple choice questions when possible, but open-ended is fine too
- Group related consequential questions; do not impose a fixed interview cadence
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why
- YAGNI ruthlessly - remove unnecessary features from every approach and design

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Request a decision only for unresolved choices that materially affect scope or risk; do not require approval after each section
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

**Design for isolation and clarity:**

- Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently
- For each unit, you should be able to answer: what does it do, how do you use it, and what does it depend on?
- Can someone understand what a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.
- Smaller, well-bounded units are also easier for you to work with - you reason better about code you can hold in context at once, and your edits are more reliable when files are focused. When a file grows large, that's often a signal that it's doing too much.

**Working in existing codebases:**

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work (e.g., a file that's grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design - the way a good developer improves code they're working in.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design (architectural path)

**Documentation and review:**

Use the current document map and existing task location. Do not recreate retired `docs/superpowers` plans/specs. Write an ADR or current plan only when the request or a genuinely needed in-scope handoff warrants it; do not commit it without authorization.

Check the resulting design for contradictions, unresolved decisions, missing acceptance criteria, and scope creep. Correct actual defects, but do not add a second spec-review approval when the design is already approved. Then implement directly or use the available `writing-plans` method if a plan is needed. When that skill is unavailable, outline affected files, contracts, dependencies, and acceptance evidence inline.

## Visual Companion

A browser-based companion for showing mockups, diagrams, and visual options during brainstorming. Available as a tool — not a mode. Accepting the companion means it's available for questions that benefit from visual treatment; it does NOT mean every question goes through the browser.

**Offering the companion (just-in-time):** Do NOT offer it upfront. Wait until a question would genuinely be clearer shown than told — a real mockup / layout / diagram question, not merely a UI *topic*. The first time that happens, offer it then, as its own message:
> "This next part might be easier if I show you — I can put together mockups, diagrams, and comparisons in a browser tab as we go. It's still new and can be token-intensive. Want me to? I'll open it for you."

**This offer MUST be its own message.** Only the offer — no clarifying question, summary, or other content. Wait for the user's response. If they accept, start the server with `--open` so their browser opens to the first screen automatically. If they decline, continue text-only and don't offer again unless they raise it.

**Per-question decision:** Even after the user accepts, decide FOR EACH QUESTION whether to use the browser or the terminal. The test: **would the user understand this better by seeing it than reading it?**

- **Use the browser** for content that IS visual — mockups, wireframes, layout comparisons, architecture diagrams, side-by-side visual designs
- **Use the terminal** for content that is text — requirements questions, conceptual choices, tradeoff lists, A/B/C/D text options, scope decisions

A question about a UI topic is not automatically a visual question. "What does personality mean in this context?" is a conceptual question — use the terminal. "Which wizard layout works better?" is a visual question — use the browser.

If they agree to the companion, read the detailed guide before proceeding:
[visual-companion.md](visual-companion.md)
