# whydiff competitive analysis (August 2026)

Source: market research on AI-code-review and diff-comprehension tools.
`/understand-diff` details were verified against the installed plugin's sources, not its marketing.

## Summary table

| Tool | What it gives the reviewer | Grouping | Diff-marked diagrams (before+after in one graph) | Tests | Ops/env | Blast radius | Completeness guarantee | Privacy |
|---|---|---|---|---|---|---|---|---|
| **whydiff (us)** | Self-contained interactive HTML map | **By cause** + reviewer roles + causal chain | **Yes** | Behavior guarantees + gap analysis | Yes | Yes | **Yes (script against git)** | Fully local |
| [CodeRabbit](https://docs.coderabbit.ai/pr-reviews/walkthroughs) | PR walkthrough, inline bugs, 1-click fix, **Change Stack** | Cohorts + ordered layers (May 2026) | No (only the new flow) | Partial | No | Partial | No | Cloud, code stored 7 days |
| [Greptile](https://www.greptile.com/docs/code-review/first-pr-review) | Summary + inline bugs on a semantic repo graph | By file | No | No | No | Partial (graph as context) | No | Cloud, SOC2 |
| [Qodo Merge / PR-Agent](https://qodo-merge-docs.qodo.ai/tools/) | PR description, file walkthrough, /improve | By file | No — [users explicitly asked (issue #1919)](https://github.com/qodo-ai/pr-agent/issues/1919) | Coverage-gap flags | No | No | No | OSS core, self-host |
| [CodeViz](https://www.codeviz.ai/use-cases/code-review) | C4 architecture maps, PR-affected components | By component | Partial (component highlighting) | No | No | Yes (deps) | No | Analysis local, AI in cloud |
| [BuilderIO visual-recap](https://github.com/BuilderIO/skills/blob/main/skills/visual-recap/README.md) | Interactive MDX recap: diffs, schemas, API diffs, UI states | By shape of change | No | No | Partial (API/schema) | No | No ("substantial enough") | Local or hosted links |
| [What The Diff](https://groupify.ai/ai-tool/whatthediff) | PR descriptions for non-technical stakeholders | Prose | No | No | No | No | No | Cloud |
| [Copilot code review](https://dev.to/rahulxsingh/github-copilot-code-review-complete-guide-2026-255h) | Prose summary + inline comments (60M reviews, ~1/5 of GitHub reviews) | By file | No | No | No | No | No | Cloud |
| [CodeSee Review Maps](https://docs.codesee.io/docs/review-map-guide) († 02.2024) | Interactive PR file map, viewed checkboxes | By folder structure | File status colors, not semantics | No | No | Partial | Manual (checkboxes) | † shut down — "structure without semantics" didn't pay off |
| [Graphite Agent](https://graphite.com/blog/introducing-graphite-agent-and-pricing) | Inline review + fixes in a stacked-PR flow | By file/stack | No | No | No | No | No | Cloud |
| understand-anything `/understand-diff` | Text analysis + highlighting on a knowledge-graph dashboard | By component/layer | Partial (changed/affected nodes) | No | Partial | **Yes (1-hop)** | No | Local, OSS |
| [ChangePrism](https://arxiv.org/abs/2508.12649) (academic) | Visualizes the "essence" of changes from git history | By change type | In spirit yes, without an AI narrative | No | No | No | No | Local |

Newcomers 2025–26: cubic (repo-wide context, low false-positive), mrge (**intelligent file
ordering** — a weak form of narrative order), Baz (Walkthrough mode), Iago
(mermaid diagrams as a skill — the genre is being commoditized), SonarQube AI Code Assurance
("AI code is reviewed differently" goes mainstream).

## What we do NOT have (honestly)

1. **Bug finding.** Every commercial player *finds defects* and competes on catch rate; we organize understanding, but we don't hunt for bugs.
2. **PR-native.** Competitors live in the PR: auto-run, comment/approve from their UI. We need a Claude Code session, and the HTML lives outside the PR.
3. **Interactivity.** Answering a question about the map means going back to Claude; Greptile/Graphite/Baz have chat right inside the review.
4. **A persistent codebase index.** Our blast radius is computed on every run (partially covered by the GRAPH integration with graphify/understand-anything).
5. **Memory between reviews.** Greptile/cubic/Baz learn from the team's reactions; we re-derive conventions every time.
6. **Collaboration.** Our HTML is a single-player artifact; visual-recap has hosted links with comments, Change Stack has shared review state.
7. **Predictable price/speed.** GitHub apps respond in 2–3 minutes at a fixed per-seat price; we spend tokens and the user's session time.
8. **Change Stack (CodeRabbit, May 2026)** — the nearest threat to the concept: cohorts + ordered layers + a polished web UI that writes back to GitHub. But: no causal "because" links, no reviewer roles, no completeness guarantee, and diagrams are "after" only.
9. **Rich artifact components** like visual-recap: OpenAPI diffs, schemas, UI screenshots.

## Our defensible advantages

1. **Diff-marked diagrams (before+after in one graph) — unique on the market.** Qodo users explicitly asked for this in issue #1919 — nobody shipped it.
2. **Deterministic completeness guarantee** ("N of N files", a script against `git diff --numstat`) — a trust property that LLM-only tools structurally cannot claim. The only precedent is the *manual* checkboxes of the late CodeSee.
3. **Causal semantics**, not just reading order: "a block exists BECAUSE of the previous one", edges (from, to, why), group roles (read / verify-pattern / context / ops / spec). Change Stack gives order, but not "why" and not "how carefully".
4. **Tests as behavior guarantees + gap analysis** instead of coverage percentages.
5. **Ops checklist with "empty = information"** — none of the review competitors report env/migrations/deploy at all.
6. **Standards against the project's OWN conventions** with counter-examples from the repo.
7. **Privacy:** fully local, no vendor server and no GitHub-app permissions; the diff leaves the machine only through the user's own Claude session.
8. **Pre-PR workflow:** we work on any local diff — an agent's uncommitted output BEFORE it becomes a PR. GitHub apps are powerless at that moment — and that is exactly the moment of reviewing LLM code.
9. **Report i18n** — nobody has it.
10. **Market tailwind:** "AI writes — people need comprehension tools" is becoming a category (SonarQube, mrge, Change Stack). CodeSee died of "structure without semantics"; the LLM era inverts its failure.

## Roadmap takeaways

- **Don't compete on bug finding** — integrate: an optional pass/bridge with `/code-review`-class tools, their findings into the "Standards" tab.
- **Positioning: pre-PR review of LLM code, locally.** This is the niche where PR apps don't work by definition.
- Cheap moves from the "don't have" list: artifact links already provide sharing; the GRAPH integration already partially covers the index; a GitHub Action that posts a link to the map in the PR is a stage-5 candidate.
- Project-convention memory between runs is a backlog candidate (a `.whydiff/conventions.md` file, appended to by the standards-reviewer).
