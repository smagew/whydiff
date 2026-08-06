# ADR: the review loop — instructions, proposals, and a Tasks tab

Status: accepted and fully implemented (2026-08-06); all seven steps below are shipped.
Supersedes nothing. Extends `scripts/serve.mjs` (ask) and `templates/viewer.html`.
Where the implementation departed from this document, the staging section says so.

## Context

`serve.mjs` gave the map one interactive capability: ask a question about an
anchored piece of the report and get an answer grounded in the real repo. That is
a read act. It leaves two things missing, and they are the ones that turn a report
into a review:

1. The reviewer cannot say **do this** — only ask.
2. Claude cannot **offer options** for the problems the map already found.

And once either exists, a third thing is needed: somewhere to see every task that
was requested or agreed, its conversation, and what it produced — the equivalent
of a GitLab merge-request discussion, except the places a comment can attach to
are wider than lines of code (a user story, a diagram node, a test gap, a finding).

The load-bearing constraint is that **a map is an observation of one snapshot.**
A question does not invalidate it. A completed task does: the tree changes, the
diff changes, the map is stale, anchors drift. Any design that stores tasks inside
`review-map.json` inherits GitLab's outdated-comment problem by construction.

## Decision

Four separate aggregates, one append-only journal, execution behind an apply gate.

| Aggregate | What it is | Property |
|---|---|---|
| **Map** | an observation of `base..head` | immutable, has an id |
| **Note** | one utterance on an anchor | append-only |
| **Task** | an intent to change something | state machine |
| **Revision** | a realized change for a task | points at a task and at its own follow-up map |

A **Review** is the aggregate root: a chain of maps + the journal of notes and
tasks. It lives *outside* the map, in `.whydiff/review.log.jsonl`, and survives
regeneration of the map it discusses.

Three decisions that were open and are now settled:

- **Execution:** ship the queue first (tier 2 below), then worktree execution with
  an apply gate (tier 3). Never a write-enabled agent driven straight into the
  reviewed working tree by an HTTP endpoint.
- **Task lifetime:** a task belongs to the *review*, not to a single map. It
  outlives regeneration; its anchor is rebound (see Rebinding).
- **Surface:** a dedicated Tasks tab, second in the row, after Logic.

## Domain model

### Anchor

Already the strongest part of the viewer; it only needs to cover every kind of
place a review remark can attach to, and to record which map it was made on.

```jsonc
{
  "kind": "story|block|blocks|diagram|diagram-node|selection|file|finding|gap|ops|blast|edge",
  "key":  "story:3",          // data-anchor value; unique within a map
  "label": "customer: I get my money back…",
  "files": ["api/refunds.py"],
  "quote": "…",               // selection anchors only
  "context": "…",             // what was on screen, for grounding
  "mapId": "m_9f3ac1"         // which observation this was made on
}
```

`finding`, `gap`, `ops`, `blast`, `edge` and `file` are new. Findings and gaps have
no stable id in the current schema, so their key is `<kind>:<index>` into the map's
own array — the format the viewer stamps on those elements and `mapFindings()`
derives, so a remark made on screen and a finding counted by the manifest are the
same thing. (An earlier draft of this ADR specified a content hash of
`(kind, file, text)`; index plus rebinding-by-quote turned out to be the simpler
half of that, and rebinding is what survives reordering either way.)

### Note

One shape, several speech acts. This is the generalization of today's thread entry.

```jsonc
{
  "noteId": "n_014", "at": "…", "by": "reviewer|claude",
  "anchor": { … },
  "kind": "question|answer|instruction|proposal|decision|report",
  "text": "…",
  "taskId": "t_003",          // present once the note belongs to a task
  "replyTo": "n_013",
  "steps": ["read api/refunds.py", "grep settle"]   // answers/reports only
}
```

An `instruction` is not a question with a different prompt: it is the event that
creates a Task. A `proposal` creates nothing until a `decision` accepts it.

Contract for `instruction`: Claude replies with a **plan and the questions it
needs answered — never an edit.** What it intends to change, where, how it will be
verified, what it might break. The reviewer confirms; only then does the task
become `open`. Structure first, work lazily — the same rule the report itself
follows.

### Task

A separate aggregate that notes reference, not a kind of note. Otherwise "show me
the conversation" and "continue the work" fight over one structure.

```jsonc
{
  "taskId": "t_003",
  "threadKey": "story:3",     // the conversation it continues
  "anchor": { … },
  "origin": "reviewer|proposal",
  "from": "n_012",            // the instruction or accepted proposal
  "finding": "gap:8f2a…",     // set when the task descends from a map finding
  "spec": "one paragraph: what must change",
  "acceptance": { … },        // see below — mandatory
  "state": "proposed|open|in_progress|done|verified|declined",
  "declinedReason": "…",
  "resolution": { "files": [], "patch": ".whydiff/tasks/t_003.patch",
                  "commit": null, "followUpMapId": "m_a10bc4" },
  "supersedes": null
}
```

Three rules worth defending:

1. **`acceptance` is mandatory and typed.** For LLM-written code, "done" asserted
   by the same model is worth nothing. Typed acceptance lets verification be
   *re-derived* by a pass instead of claimed:

   ```jsonc
   { "type": "test",    "name": "test_refund_unshipped_order_settles" }
   { "type": "story",   "key": "story:3", "becomes": "delivered" }
   { "type": "finding", "key": "finding:8f2a…", "gone": true }
   { "type": "manual",  "what": "reviewer confirms by reading the patch" }
   ```

   `verified` is only ever set from evidence of the first three kinds, or by an
   explicit reviewer act for `manual`.

2. **`declined` is kept forever, with a reason.** A rejected proposal is
   information — the same way an empty `ops.env` is information. The next run must
   not re-propose it, and a reviewer three weeks later must see that the decision
   was made deliberately.

3. **No assignee, priority, label, estimate or due date.** The unit here is one
   change and one review, not a backlog. The second tracker field is the point
   where whydiff starts losing at a game trackers already win.

### Proposal

A proposal must **cite the finding it descends from.** Free-form "let's refactor
this" is noise. The map already carries the problem statements:
`standards[severity="warn"]`, `tests.gaps[]`, `userStories.stories[status != "delivered"]`,
`blastRadius[]`.

```jsonc
{
  "finding": "story:3",
  "variants": [
    { "kind": "local",    "what": "…", "cost": "…", "risk": "…", "blast": ["…"], "acceptance": {…} },
    { "kind": "root",     "what": "…", "cost": "…", "risk": "…", "blast": ["…"], "acceptance": {…} },
    { "kind": "document", "what": "…", "cost": "…", "risk": "…", "blast": [],    "acceptance": {…} }
  ],
  "noFixNeeded": null       // set, with a reason, instead of variants
}
```

Variants must differ in **kind, not in wording**: `local` fixes the symptom where
it shows, `root` fixes the invariant (more expensive, wider blast radius),
`document` declines to change behaviour and pins it with a test or a note. That is
what an engineer offering options actually does.

- **Generation is lazy**, per finding, on click. An eager pass would make every run
  pay for advice that is read 20% of the time. A batch pass may exist behind a flag.
- **Completeness is checked by script, not by the model:** every `warn`, `broken`,
  `regressed` and `gap` must end up with a decision — a task, a decline, or an
  explicit `noFixNeeded` with a reason. `coverage()` counts it and lists what is
  left; it is the same guarantee as the file manifest, applied to decisions, and it
  reports rather than fails, because options are generated on demand.
- Proposals are **journal events, not map fields.** The map stays an observation.

## Journal contract

`.whydiff/review.log.jsonl` — one JSON object per line, append-only. Everything
else is a projection.

```jsonc
{ "id": "ev_9f3ac1", "at": "2026-08-06T13:02:11Z", "by": "reviewer|claude", "type": "…", … }
```

Ids (`ev_`, `n_`, `t_`) are opaque random tokens, not counters: two writers append
with no coordination, so a "next number" would collide. Order comes from position
in the log, never from the id.

| `type` | Payload | Emitted by |
|---|---|---|
| `map.observed` | `mapId, ref, base, head, generatedAt, stats` | `merge.mjs` |
| `note.added` | the Note above | server / work skill |
| `task.opened` | the Task, at `proposed` or `open` | server / work skill |
| `task.state` | `taskId, state, reason?` | either |
| `task.resolved` | `taskId, files[], patch, commit?, followUpMapId?` | worker |
| `task.verified` | `taskId, evidence` | verification pass |
| `anchor.rebound` | `oldKey, newKey, mapId, how: exact\|quote\|stale` | `rebind.mjs` |

Why a log instead of a mutable `review.json`:

- **Two writers.** The page and the terminal session both write, with no locking
  and no clobbering.
- **The history the feature is for.** "History of changes and correspondence" *is*
  the log; no extra machinery needed to reconstruct it.
- **It fits the project's taste.** Deterministic scripts, manifests, verifiable
  state — the same reason completeness is a script and not a prompt.

`.whydiff/review.json` is the projection: derived, gitignored, never hand-edited
(the same status as `fullFiles`). Migration from `threads.json` is a read-once
translation into `note.added` pairs (`serve.mjs:53-58`).

## Schema changes to `review-map.json`

Additive only; old maps keep rendering, and the viewer already knows how to hide a
tab whose data a run never produced.

- `meta.mapId` — content hash of `(project, base, head, generatedAt)`.
- `meta.base`, `meta.head` — resolved shas, or `working tree` plus the tree hash.
- `standards[].id`, `userStories.stories[].id`, and `tests.gaps` items gain an
  optional `id`. Absent ⇒ the anchor key is the content hash described above.
- Nothing about tasks, notes or proposals enters the map. Deliberate: the map is
  an observation of a snapshot, and the review outlives every snapshot.

## Execution model

Three tiers, each usable on its own. The **file-queue is the contract** — the
server is one driver of it, the interactive session is another. This is what keeps
the feature alive where no server exists, and it preserves viewer autonomy.

**Tier 1 — `file://` or a published artifact.** No model reachable (CSP blocks
everything; the file has no origin). The page still *composes*: tasks and notes are
held in `localStorage`, and "download `review.json`" / "copy as prompt" hands them
to a session. Read + compose, no answers.

**Tier 2 — `serve.mjs` (localhost).** Live ask, lazy proposals, journal written to
disk. New endpoints, all token-gated exactly as `/api/ask` is:

```
GET  /api/review                 → the projection
POST /api/note                   {anchor, kind, text}      → streams an answer when kind=question
POST /api/task                   {anchor, spec, acceptance, origin, from}
POST /api/task/:id/state         {state, reason?}
POST /api/propose                {anchor, finding}         → streams variants
```

Nothing here writes to the repository. `/api/propose` and question answering run
the same read-only `claude -p` shape that exists today.

**Tier 3 — `serve.mjs --work` (opt-in flag).** A task is executed by an agent in a
**fresh git worktree**, never in the reviewed tree. The result comes back as a
patch, is rendered in the same viewer as a small delta map, and reaches the working
tree only through an explicit apply:

```
POST /api/work/:taskId           → streams steps, ends with {patch, files, followUpMapId}
POST /api/apply/:taskId          → applies the patch to the working tree (gated)
```

This is the project's own thesis closed into a loop: **an LLM edit does not land in
the tree without having been looked at through a map.** It is also the only shape
that answers "is the fix worse than the disease".

Rejected: an endpoint that lets a headless, write-enabled agent edit the reviewed
tree directly. It has no UI for permission prompts, bypasses the hooks the user
already trusts, and turns a nearly read-only server into the most dangerous process
in the repo.

Alongside tier 2, a `/whydiff-work` skill drains the same queue inside the normal
interactive session — full context, ordinary permission flow, no new trust surface.
That is the first executor to ship.

## Viewer: the Tasks tab

The tab's job is **not to list tasks**. It answers one question: *can this be
merged, and what is still unsettled?*

- **Header is a verdict**, not a count: `blocking 3 · agreed 2 · declined 5 ·
  done/verified 4` — and an explicit "nothing blocking" when that is true.
- **Grouped by the source of the problem** — broken story / standards / test gap /
  reviewer's instruction — not by status. Groups are roles in a review; that is
  already how the Files tab thinks.
- **Unresolved questions appear here too.** A question with no answer, and an
  answer that says the report is wrong, are both open items of the review. This is
  what separates the tab from a to-do list.
- **A card is:** the anchor (click → jump to its place on its own tab), the intent
  in one line, the state, the thread collapsed, and for `done` a link to the patch
  and to the delta map.
- Badge counts *blocking* items, the way the stories badge counts problems rather
  than stories.

Navigation both ways is already built: `anchorOf`, `elFor`, `refreshMarks`,
`layoutRail` (`templates/viewer.html:1654-1774`). The tab is a projection of the
journal over the anchor model that exists.

The ask panel gains a mode switch — **Ask / Instruct** — and no new surface. The
difference the reviewer feels is in the reply contract, not the widget.

## Rebinding across regeneration

When `/whydiff` regenerates the map, `scripts/rebind.mjs` runs after `merge.mjs`
and, for every anchor in the journal:

1. exact key match in the new map ⇒ bound;
2. else quote/label match ⇒ rebound, `anchor.rebound {how:"quote"}`;
3. else `stale`, with the original quote preserved and shown as such.

**Nothing is ever silently dropped.** The one moment a review tool needs to be
trusted is the moment it says a remark no longer applies.

History is a chain of maps, never a mutated map: a task's `resolution` names the
patch and the follow-up `mapId`, so "what did this task change" is answerable
without rewriting the observation it came from.

## Staging

Each step is useful on its own.

1. ✅ (2026-08-06) Journal + projection in `scripts/review.mjs` (its own module —
   `lib.mjs` is the diff/map layer, this is the review layer); `threads.json`
   migrated once and kept; `serve.mjs` writes notes instead of `threads.json` and
   serves `/api/review`; `tests/review.mjs`.
2. ✅ (2026-08-06) **Instruct** mode in the existing panel → plan reply, then
   agree (task opens) or not now (a decision note, so it is not re-offered). No
   execution; `POST /api/instruct|task|task-state|note`; both speech acts pair into
   one `turn` shape (`turns()`), so the panel has one renderer. The planning and
   answering runs are spawned with a read-only allowlist **and** an explicit deny
   list (`Edit,Write,NotebookEdit,Bash,Task,Agent`), which is what actually makes
   "this server does not edit" a property of the process — an allowlist alone only
   pre-approves, as the first live run demonstrated by shelling out to `grep`.
3. ✅ (2026-08-06) Tasks tab: projection, verdict header (`blocking N` / `nothing
   blocking`), grouping by source, unanswered questions in the same list, anchor
   jumps through the existing `jumpTo`, decline-with-a-reason and reopen, and
   **copy the queue as a prompt** — the handoff to the session that can actually do
   the work, until step 5 automates it. Built in the served-only module, so the
   standalone file and the artifact have no tab at all.
4. ✅ (2026-08-06) Lazy options with typed variants + the decision manifest.
   `POST /api/propose`; variants normalised server-side (unknown kind dropped,
   duplicate kind dropped, missing criterion filled) so a sloppy reply costs fields
   rather than the whole proposal; the journal then insists every variant carries a
   typed `acceptance`. `mapFindings` / `coverage` in `review.mjs` — reported as
   `decided d/t` on the Tasks tab, listed as "Not decided yet", and printed by
   `review.mjs --map`. **Deviation from the plan above:** the affordance is a third
   panel mode (Ask / Instruct / Options), not a second hover button on the card —
   two hover controls would fight the comment pin for the same corner. The mode is
   refused where there is no finding to cite, which keeps "a proposal must descend
   from a finding" true in the UI as well as in the log.
5. ✅ (2026-08-06) `/whydiff-work` — executor inside the interactive session, plus
   the write half of the `review.mjs` CLI (`--next` / `--thread` / `--start` /
   `--resolve` / `--verify` / `--decline` / `--report`), so a work session drives the
   journal through the same validation the page does. `done` means changed;
   `verified` requires evidence from a run, and only a `test` criterion is the
   session's to close.
6. ✅ (2026-08-06) Worktree execution and the apply gate, behind `serve.mjs --work`.
   `POST /api/work` runs the task in a throwaway worktree and returns a patch;
   `POST /api/apply` is the only path into the reviewed tree, and refuses a patch
   that no longer applies rather than forcing it. Both are 403 without the flag.
   - The worktree is seeded from **the working tree as it stands** (via
     `git stash create`), not from HEAD: the reviewed change is often the working
     tree itself, so HEAD would hand the worker a copy without the diff under
     review. Untracked files cannot ride along on a stash — they are reported to the
     worker and to the reviewer instead of being silently absent.
   - An empty patch is not a resolution: the run's report is journalled and the task
     goes back to `open`, because a `task.resolved` with nothing in it is a lie.
   - Applying is journalled as the reviewer's `decision` note carrying `applied`, so
     no new event type was needed and the Tasks tab can say "applied to the working
     tree" from the log alone.
   - **Scope correction to this ADR:** the result is shown as the *patch*, rendered
     with the report's own add/del/ctx styling and an expand toggle — not as a
     generated review map of the fix. A real delta map means running the five-agent
     pipeline, which does not belong inside an HTTP handler; the reviewer who wants
     one runs `/whydiff` after applying. The gate, which is the load-bearing part,
     is unchanged.
   - The server also **re-reads the journal when the log file moves**, so a
     `/whydiff-work` session in the terminal and the page no longer disagree about
     what has been decided.
7. ✅ (2026-08-06) `rebind.mjs` + `stale` rendering. `planRebinds` decides per
   anchor against the regenerated map: exact key with matching text → untouched,
   text found elsewhere → rebound, text gone → `stale` with the original text kept,
   text back again → revived. Quoted selections are checked against the map's whole
   prose rather than a key. Multi-block anchors and single diagram nodes are never
   guessed about. Idempotent, so the pipeline calls it unconditionally after
   `validate.mjs`; it also records each map it has seen (`map.observed`). The page
   labels a stale anchor in the panel and on its task card, and the thread still
   opens and reads.

## Risks and rejected alternatives

- **A general chat box.** Rejected. The moat is a short exchange bound to a place
  and a purpose; free chat makes this Claude Code with fewer features.
- **The viewer as source of truth.** Rejected. Files on disk are; the page and the
  session are peers.
- **Tasks inside `review-map.json`.** Rejected — it makes the observation mutable
  and imports the outdated-comment problem.
- **Tracker fields** (assignee, priority, sprint). Rejected as scope drift.
- **Eager proposal pass on every run.** Rejected on cost; lazy by default, batch
  behind a flag.
- **Cost in general.** Every proposal and every answer spends tokens through the
  CLI, and the UI must keep saying so where it is spent.
