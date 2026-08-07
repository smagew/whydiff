# Changelog

Notable changes to the whydiff plugin. Versions follow semver; the plugin
version in `.claude-plugin/plugin.json` must be bumped for installed users
to receive an update.

## [0.10.0] — 2026-08-07

The overview panel becomes a per-group index, and the Files map stops fighting the
reader.

### Added
- **The overview panel now maps every cause group to its files.** The right-hand
  panel used to be a bare legend (group names and roles). It now walks each group in
  turn — its tag and name, the one-line reason in a note box, then its files as rows
  (type label, path, `+/-` counts). Every row opens that file's diff, so the overview
  doubles as an index. The file map on the left is unchanged.

### Changed
- **A connection label carries a title and a description.** A short title rides the
  line; hovering it opens the full description, with a "more" toggle when the text is
  long — instead of one label stretched across the map.
- **"Show all links" is on by default** on the Files map, so every connection is
  visible when the tab opens rather than only on hover or select.
- **The user-stories tab drops its intro paragraph.** The verdict is already clear
  from the traffic-light badges and the problems-first ordering, so the summary and
  explainer above the cards only took space.

### Fixed
- **The content no longer shifts sideways between tabs.** The floating bookmark rail
  reserved a left gutter only on the tabs that had anchored questions, so the reading
  column jumped whenever you switched. Questions are now counted on each tab's own
  button; the rail is gone and the column keeps the same width on every tab.

## [0.9.2] — 2026-08-07

More fixes to the chrome, and to how a run is handed over.

### Fixed
- **The page no longer jumps when you switch tabs.** The right column collapsed on
  the prose tabs and came back on Logic/Diagrams/Files, so the reading column
  resized every time — the whole page appeared to stretch and shrink. The grid is
  now the same on every tab (a prose tab leaves the reserved area empty instead of
  growing into it), the responsive single-column collapse still applies because
  `.solo` no longer out-specifies the media query, and `scrollbar-gutter: stable`
  keeps a scrollbar appearing on a long tab from shifting everything sideways.
- **A long connection label no longer stretches across the map.** An edge's label
  can be a whole sentence; drawn full-length on the line it spanned the entire
  window. It is now capped and ellipsised on the line, with the full text on hover
  and in the inspector's Links. The schema and classifier also now ask for a short
  phrase, not a sentence, so the label fits the line in the first place.
- **The Tests tab stops wasting half its width.** When no tests are fixed (or no
  gaps), the empty side no longer holds an idle half-column — the populated list
  takes the full width and the empty one stays as its count line.

### Changed
- **A run serves the live report by default; the static file is now opt-in.** With
  the report gone interactive — ask, instruct, options, and Generate for the lazy
  sections — a static HTML can do none of that (its buttons are inert), so handing
  one over left the reviewer with a dead page. `SKILL.md` now serves unless the
  user explicitly wants a file to keep or an artifact to publish.

## [0.9.1] — 2026-08-07

Two small fixes to the chrome around the map.

### Fixed
- **Thread bookmarks no longer pile over the header.** A question's marker belongs
  beside its own content or, when that content is on another tab, as a count on
  that tab — and a thread whose anchor is gone (the map was regenerated) has
  nothing to sit beside at all. The rail had been dropping those lost markers at
  the top-left corner, on top of the title. Now they are not floated: detached
  threads live in the Review view (their `questions` group), and the rail — with
  the left margin reserved for it — appears only when a bookmark can actually sit
  beside content on the current tab.

### Added
- **The footer names the version that produced the map** — `whydiff <version>`,
  stamped by `assemble.mjs` from `.claude-plugin/plugin.json`, so a served or
  exported report says which whydiff built it.

## [0.9.0] — 2026-08-07

**The report generates lazily.** A default run now builds only the core — Logic,
Diagrams, Files and Ops (env) — and leaves the heavier passes for when they are
actually wanted. The other tabs stay in the menu, but opening one that has not run
shows what it is and a **Generate** button that produces just that section and
folds it into the existing map. A big diff no longer pays for standards, tests and
user-story analysis it may never look at; a reviewer who wants the whole picture is
one click (or one word — "full") away.

### Added
- **Lazy sections with on-demand generation.** The default pipeline spawns only the
  two core agents (`classifier` + `diagrammer`). The three optional passes —
  `standards-reviewer`, `tests-analyst`, `story-writer` — are not run up front:
  their tabs render a one-line explanation and, in served mode, a **Generate**
  button. Clicking it runs that pass against the same diff and adds its section to
  the report without re-running anything else.
- **`POST /api/generate` (`scripts/serve.mjs`).** Runs the section's own agent
  through `claude -p` with the read-only allowlist, streams its progress to the
  page, parses the section JSON, patches `review-map.json`, re-assembles the served
  HTML, and the viewer reloads to show it. It writes only the report's own JSON in
  `.whydiff/` — never the repo — so it keeps the same read-only guarantee as ask,
  instruct and propose.
- **`generated` on the map.** `merge.mjs` records which optional passes actually
  ran — by whether their agent file exists, so "ran and found nothing" stays
  distinct from "not run" — and the viewer offers Generate for the rest. The schema
  documents the field; maps written before it fall back to key presence.
- **A bounded board, and connections that say what they are.** The tab strip and
  the content beneath it now read as one outlined, filled card, so it is
  unmistakable that the content belongs to the selected tab. On the Files map every
  dependency line carries its relationship in words — on a solid pill so it stays
  legible over a card — shown with its edge on hover/select or with "show all links".

### Changed
- **The skill defaults to core; the optional passes are opt-in.** `SKILL.md`
  documents core vs full-only in the agent table and spawns the three optional
  passes only when the user asks for a **full** report.

### Fixed
- **The permission hook stops interrupting a run.** `hooks/hooks.json` now also
  matches `Task`, and `scripts/approve.mjs` auto-approves the plugin's own bundled
  agents (`whydiff:*`) and read-only `gh pr diff|view`. Under *accept edits* a
  `/whydiff` run no longer prompts on each of the agent spawns or a PR fetch;
  anything outside the plugin's own operations still defers to the normal flow.

## [0.8.0] — 2026-08-07

Housekeeping, and the reason it needed a version: the screenshots.

### Changed
- **Screenshots carry the version they show** — `assets/story-0.8.png` and friends.
  The 0.7.0 shots replaced the old files at the same paths, so a browser (and any
  CDN in front of it) kept serving the previous picture: the README looked stale
  when the repository was not. A changed picture now gets a new filename, which is
  a URL nothing can have cached, and the README says so where whoever re-shoots
  will read it.
- No behaviour changes. The version bump exists so an installed copy picks up the
  0.7.0 review loop even if it was installed while that release was in flight.

## [0.7.0] — 2026-08-06

**The map becomes a review, not just a report.** Until now whydiff explained a
change and could answer questions about it. This release lets the reviewer act:
instruct, weigh options, agree on work, watch it happen in a throwaway worktree,
and apply the result — with every remark, decision and result kept in an
append-only journal that survives regenerating the map. The design is
`docs/review-loop.md`; the guarantees it is built on are that a map is an
observation of one snapshot, that verification is earned rather than asserted, and
that nothing an LLM writes reaches the working tree unlooked-at.

### Added
- **`docs/review-loop.md` — the ADR for turning the map from a report into a review
  loop**: the reviewer instructing Claude, Claude proposing typed fix variants, and
  a Tasks tab holding every request, its conversation and what it produced. The
  load-bearing decision is that a map is an *observation of one snapshot*: a
  question does not invalidate it, a finished task does, so tasks live outside the
  map in four separate aggregates (Map / Note / Task / Revision). Execution ships
  as a queue first and a git-worktree agent behind an apply gate second — never a
  write-enabled endpoint pointed at the reviewed tree.
- **`scripts/review.mjs` — the review journal, first step of that ADR.** An
  append-only `.whydiff/review.log.jsonl` plus the projection (`review.json`) the
  Tasks tab and the work skill will read.
  - **A log, not a mutable file**, because two writers — the served page and a
    Claude Code session in the same repo — append without locking, and the history
    the Tasks tab must show *is* the log rather than something reconstructed from it.
  - Refuses what it could not read back later: unknown event types, an anchor with
    no key, an empty utterance, a proposal that cites no finding or offers no real
    variants, a task with no typed `acceptance`, an illegal state transition, a
    decline with no reason, a resolution with no patch, a verification with no
    evidence. A batch is all-or-nothing.
  - Tolerates what it *reads*: an event kind only a newer whydiff knows is kept
    aside instead of throwing, and a line torn by a mid-write crash costs that one
    line. Rebind chains resolve in one pass and cycles cannot hang it.
  - `serve.mjs` now writes questions and answers as notes and serves the whole
    projection at `/api/review`; the viewer's own `/api/threads` shape is unchanged,
    so the ask UI is byte-for-byte the same. A pre-journal `threads.json` is
    migrated exactly once and kept as `threads.migrated.json` — it is the only copy
    of those answers. `node scripts/review.mjs <dir>` reads the journal from a
    terminal.
  - `tests/review.mjs` covers all of the above; `tests/serve.mjs` now asserts the
    journal (question, answer, `replyTo` link, steps, anchor) and the projected
    counts instead of `threads.json`.
- **Instruct mode — the reviewer can now say what should change, not only ask.**
  The ask panel gains one segmented control: *Ask* answers a question about the
  anchored place, *Instruct* takes an instruction about it and replies with a
  **plan** — file by file, what will prove it done, what could break, what must be
  answered before starting. Then two buttons: agree, which opens a task in the
  journal with the plan's spec and acceptance, or not now, which is journalled as a
  decision so the same plan is not offered again.
  - **A plan, not an edit.** The reply is something to decide on; the task it opens
    is a queue entry the user's own session drains. Nothing here executes.
  - **Read-only by construction:** the answering, planning and options runs are
    spawned with a `Read,Grep,Glob` allowlist *and* an explicit
    `--disallowedTools Edit,Write,NotebookEdit,Bash,Task,Agent`, so "this server does
    not change the repo" is a property of the process rather than a sentence in a
    prompt. The deny list is the part that matters: an allowlist only pre-approves,
    and the first live run showed the "read-only" path shelling out to `ls` and
    `grep` quite happily. Subagents are denied too — otherwise they are the way
    around it. `tests/serve.mjs` asserts the deny list reaches the CLI.
  - The plan's machine-readable tail (spec, typed acceptance, files, risks,
    questions) is split off the prose and never streamed to the page — the reviewer
    reads a plan, not a JSON block. A model that ignores the format costs the
    structured fields, not the plan: the task can still be opened from the
    instruction itself.
  - Questions and instructions pair into one `turn` shape (`turns()` in
    `review.mjs`), so the panel keeps a single renderer and the journal a single
    shape. Markers, bookmarks and tab badges count notes of both kinds, and their
    wording changed accordingly.
  - `POST /api/instruct`, `/api/task`, `/api/task-state`, `/api/note`. Every one of
    them validates through the journal, so an endpoint cannot write what the log
    would refuse — `tests/serve.mjs` asserts a task with no acceptance is a 400 and
    an illegal state jump is refused, in the browser as well as over HTTP.
- **A Tasks tab — and it is a merge gate, not a to-do list.** Second in the row,
  present only on the served copy (built in the ask module, so the standalone file
  and the published artifact have no such tab rather than an empty one).
  - The header is a **verdict**: `blocking N` in the warning colour, or `nothing
    blocking` when that is true, then done/verified/declined counts only when they
    are non-zero. The tab badge counts what *blocks*, not what exists.
  - Cards are grouped **by where the problem came from** — your own instructions, a
    broken user story, a standards finding, a test gap — because the same status on
    a defect and on a request means different things. Blocking states sort first.
  - **Unanswered questions are in the same list.** A question nobody answered is an
    open item of the review, and that is what separates this tab from a task list.
  - Every card links back to its place in the report through the same `jumpTo` the
    bookmark rail uses, so it opens the right tab, scrolls to the anchor and opens
    the thread. Declining asks for the reason inline, since the journal refuses a
    decline without one; a declined card can be reopened.
  - **Copy the queue as a prompt** is the handoff: the agreed tasks with their
    acceptance criteria, anchors and files, plus the journal path, as text to paste
    into a Claude Code session — useful now, and replaced by `/whydiff-work` later.
    It refuses to pretend, saying "nothing agreed to copy yet" when the queue is
    empty.
- **Options: Claude offers ways to deal with a finding, and the manifest counts
  whether anything was decided.** A third panel mode (`POST /api/propose`), offered
  only where the map itself reported a problem — a standards `warn`, a test gap, or
  a story that is not `delivered`. Those are now anchors too, so they can be asked
  about and instructed on as well.
  - **Two or three options that differ in KIND, not in wording:** `local` fixes the
    symptom, `root` fixes the invariant that allowed it, `document` declines to
    change behaviour and pins it with a test instead. Each carries cost, risk, blast
    radius and the criterion it would be judged by; choosing one opens a task whose
    spec is that option and which keeps the finding it descends from.
  - **A proposal must cite a finding**, in the UI as well as in the log: the mode is
    disabled anywhere there is no finding to cite (a Logic block, a text selection)
    and says why. `noFixNeeded` with a reason is a first-class answer.
  - Variants are **normalised server-side** — an invented kind dropped, a duplicate
    kind dropped, a missing criterion filled — so a sloppy reply costs the
    structured fields rather than the proposal the reviewer just paid for. The
    journal then insists every stored variant has a typed acceptance.
  - **Criteria name keys, not prose.** The first live run had the model answer
    `{"type":"story","key":"customer: I can get my money back…"}` — reads well,
    verifies nothing. Both prompts now carry the menu of keys the map actually
    offers, and whatever comes back is matched against it: a wording that belongs to
    a known key is rewritten to that key, and anything unmatchable degrades to
    `manual` rather than being stored as a criterion no pass could ever close.
  - **The decision manifest** (`mapFindings` / `coverage` in `review.mjs`): the
    Tasks header reads `decided 3/7`, undecided findings are *listed* rather than
    just counted, and `node scripts/review.mjs <dir> --map <map>` prints the same
    from a terminal. Coverage is a read model, not journal state — it needs the map,
    which the journal deliberately knows nothing about.
- **`/whydiff-work` — the other half of the loop: the agreed work actually gets
  done, in your own session.** A second skill (`skills/whydiff-work/SKILL.md`) that
  drains the review queue one task at a time, and the write half of the
  `review.mjs` CLI it drives the journal through: `--next` / `--thread` (a task plus
  the whole discussion that produced its spec), `--start`, `--resolve`, `--verify`,
  `--decline`, `--report`.
  - **In the interactive session, not behind an endpoint**: full context, the
    ordinary permission flow for source edits, and no write-enabled agent reachable
    over HTTP. The plugin's hook still only auto-approves its own scripts and writes
    inside `.whydiff/`.
  - **The spec is the boundary.** Work that turns out to need something nobody
    agreed to stops and reports on the thread instead of widening silently — that is
    the failure the review exists to catch, so the skill must not commit it either.
  - **Verification is earned, not asserted.** `done` means changed; `verified`
    requires the command and its real output, and only a `test` criterion is the
    session's to close — `story` and `finding` criteria are closed by regenerating
    the map and seeing them flip, `manual` by the reviewer. Every CLI write goes
    through the journal, so `--verify` with no evidence is refused rather than
    recorded, and `tests/review.mjs` asserts exactly that.
  - A blocking question in the discussion stops the task instead of being guessed
    past; the patch for each task lands in `.whydiff/tasks/<taskId>.patch` so the
    reviewer can read the result as a change.
- **`serve.mjs --work` — the loop closes: an agreed task can be worked from the
  report, and its patch reaches the tree only through a gate.** Opt-in flag; without
  it `/api/work` and `/api/apply` are refused with a message saying this server reads
  and plans. A task card gains *do it in a worktree*, streams the agent's steps while
  it runs, then shows the produced patch — file by file, with the report's own
  add/del styling — above **Apply to the working tree**.
  - **The worktree is seeded from the working tree as it stands**, not from HEAD, via
    `git stash create`. The reviewed change is often the working tree itself, so HEAD
    would hand the worker a copy missing the very diff under review. Untracked files
    cannot ride on a stash, so they are named to the worker and to the reviewer
    rather than being quietly absent. `tests/work.mjs` builds a real git repo with an
    uncommitted change and asserts the worker saw it.
  - **The reviewed tree is untouched until the reviewer says otherwise** — asserted
    directly: the stubbed worker writes files into whatever directory it runs in, so
    if the run were not isolated, the test fails. The worktree is removed afterwards.
  - **An empty patch is not a resolution.** The report is journalled, the task goes
    back to `open`, and the page says the run produced no changes — a
    `task.resolved` with nothing in it would be a lie.
  - **A patch that no longer applies is reported, never forced** (`git apply --check`
    first): applying twice, or after the tree moved on, is a 409 that explains
    itself. Applying is journalled as the reviewer's `decision` note carrying
    `applied`, so no new event type was needed.
  - **The server now re-reads the journal when the log moves**, so a `/whydiff-work`
    session in the terminal and the open page stop disagreeing about what has been
    decided — the multi-writer premise of the log finally holds end to end.
  - Deliberate scope correction to the ADR: the result is shown as the **patch**, not
    as a generated review map of the fix. A real delta map means running the
    five-agent pipeline, which does not belong in an HTTP handler; `/whydiff` after
    applying is how you get one. Worktree isolation protects files, not the machine —
    the worker can run commands, which is why the mode is opt-in.
- **A palette switcher in the corner, so the choice is one click instead of a
  keystroke.** Three swatches top-right, each painted in the palette it selects —
  the active one carries a ring, and the whole control disappears in focus mode.
  - A swatch has to show a palette that is *not* the active one, so it cannot read
    the live CSS variables. It does not restate their values either: a palette is an
    attribute selector, so an offscreen probe carrying `data-p` resolves that
    palette's own `--canvas` and `--mark`. Swatches therefore cannot drift from the
    tokens they advertise, and the "no hardcoded hex outside the token block" rule
    stays absolute — its own test caught the first version of this.
  - The ring is an `outline`, not a `box-shadow`: this system has no shadows outside
    overlays, and `tests/design.mjs` enforces it.
- **`scripts/rebind.mjs` — the journal survives regenerating the map, and says
  honestly when it cannot.** A map is an observation of one snapshot: regenerate it
  and a story sits at a different index, a fixed finding is gone, a Logic block was
  reworded. This decides per anchor what happened — moved → rebound, gone → kept and
  marked `stale` with its original text, back again → revived — and the pipeline runs
  it after `validate.mjs` on every run (with no journal it prints one line and does
  nothing).
  - **Nothing is dropped.** The one moment a review tool has to be trusted is when it
    says a remark no longer applies, so a stale thread still opens, still reads, and
    carries the text it was attached to; the page labels it in the panel and on the
    task card rather than pointing at whatever now occupies that key.
  - Quoted selections have no key to move to, so they are checked against the map's
    whole prose instead. Multi-block anchors and single diagram nodes are never
    guessed about — their identity is not derivable from the map, and guessing would
    be worse than saying nothing.
  - Idempotent by construction (a second run against the same map emits nothing), and
    each observation is recorded as `map.observed`, so the journal holds the chain of
    maps a review has passed through. `--dry` prints the plan without writing.
  - `tests/rebind.mjs` covers moved / stale / revived / untouched, that the offered
    keys are exactly the ones the viewer stamps, idempotence, and the CLI no-op;
    `tests/work.mjs` asserts the stale label and that the discussion still reads.
- **`agents/story-writer.md` — a fifth analysis pass, and the first one that is
  not engineering-facing.** Every other pass describes the change to whoever is
  reading the code; this one reconstructs what changed *outside*, in the actor's
  words. Each story carries a verdict decided from the code rather than the
  intent — `delivered`, `partial`, `broken`, `regressed` — which is what keeps the
  tab from degrading into generated documentation. On the reference refunds diff
  it surfaced the change's worst defect as a story a non-engineer can read:
  *"I get my money back after my refund is agreed" — **broken***, because the API
  only accepts refunds for shipped orders while settlement only runs from the
  fulfilment path, which skips them. `regressed` is the status that earns the tab:
  a destructive migration and a renamed response key are both easy to miss in the
  other tabs' framing and unmissable in this one.
- `userStories` in the schema (`{summary, stories[]}`, mirroring `tests`), read
  from `.whydiff/stories.json` by `merge.mjs`. An empty `stories` list is a real
  answer for a refactor — the pass is told never to pad it.
- `validateStructure` rejects an unknown `status`, an empty story, and any story
  file that is not in the diff. A story that cannot be tied to a diff file is a
  story the pass invented.
- New viewer tab, second in the row so the outside view comes right after the
  causal story. Its badge counts *problems*, not stories, and cards are re-sorted
  problems-first in the viewer as well as in the pass, so bad news cannot end up
  below the fold because of emission order. The tab is **hidden entirely** on maps
  generated before this pass existed: an empty "nothing changed outside" pane
  would assert something the run never checked.
- `tests/smoke.mjs` covers the new tab in a real browser — tab count with and
  without the section, problem badge, sort order, the "no test" marker, and the
  inspector reveal below.

- **`scripts/serve.mjs` — live Q&A about an anchored piece of the report.** Serves
  the map at `127.0.0.1` and answers questions from the page by calling
  `claude -p` in the repo, with the map, the patch and the real code available to
  it. Four anchor kinds: a user-story card, a Logic block (⌘/Ctrl-click several to
  ask one question about the set), a diagram (Alt-click a single node), and any
  text selection.
  - **Why a server exists at all**, when nothing else in this project needs one:
    the report is a self-contained file and a published artifact's CSP blocks every
    outgoing request, so the page cannot reach a model by itself. This mode trades
    self-containment for a live answer, and only the served copy gets it.
  - The ask UI is gated on a token the server injects into the page it serves, so
    the file on disk and the published artifact are **unchanged and show no ask
    controls** — absent rather than broken. `tests/serve.mjs` asserts that
    directly, and also covers token refusal, the anchor surviving into the CLI
    prompt, and the browser round-trip, with the CLI stubbed so the suite never
    calls a model.
  - Answers are appended to `.whydiff/threads.json` and reloaded on the next
    serve. A live answer that vanished with the tab would make the same question
    get asked, and paid for, twice.
  - Anchors carry a story's **original** index, not its display position, so a
    question stays attached after the problems-first sort reorders the cards.
- `make serve-<fixture>` runs it against a prepared fixture.
- **Questions leave a mark where they were asked**, the way a comment does in a
  document: a numbered pin on the story card, Logic block or diagram, and — for a
  question about selected text — the text itself stays highlighted with the pin at
  the end of the phrase. The highlight wraps each intersecting text node
  separately rather than calling `surroundContents`, which throws the moment a
  selection crosses an inline `<code>` — the common case in this prose, so the
  simple version would have silently dropped most highlights.
- **A rail of bookmarks down the left edge**, each at the height of its anchor and
  positioned in **document** coordinates, so it scrolls with the content it marks.
  A first cut pinned them to the viewport and clamped them into view; they then
  drifted against the text they belonged to and read as stray chrome. The page
  reserves a left margin while bookmarks exist, so they never sit on the text.
  Questions on other tabs are counted on that tab's button instead of floating in
  a corner. A thread whose anchor text no longer exists says so rather than
  vanishing — and a diagram question is attributed to the Diagrams tab even before
  mermaid has drawn it, instead of being reported as lost.
- **Streaming answers.** `--output-format stream-json --include-partial-messages`
  feeds an NDJSON channel to the page, so the wait shows the model's actual steps
  (`read worker/src/refunds.ts`, `grep payout`) and its text as it arrives. The
  trace folds itself away when the answer lands and stays one click from view.
  Steps are stored on the thread, so a reopened conversation still shows what the
  answer was based on.
- **Markdown in answers** — a ~40-line renderer rather than a library, since the
  page must stay self-contained and a CDN would be blocked by the artifact CSP.
  Escaping happens before any markup is produced, so an answer cannot inject HTML;
  `tests/serve.mjs` asserts that an `<img onerror=…>` in an answer stays inert.

### Fixed
- `claude -p` was waiting 3 seconds for stdin on **every** question. Its stdin is
  now closed, which is pure latency off each ask.
- The chat panel scrolled away instead of staying put. Wrapping the inspector in a
  right-hand column had left that column sized to its content — `.layout` sets
  `align-items: start` — so a sticky child had no room to travel. The column now
  stretches to the row.
- Opening a thread jumped to the end of the last answer, hiding the question that
  produced it. Only a freshly arrived answer scrolls the conversation now.

### Changed
- **Design system v2 — replaces the paper/serif pass below.** That earlier look is
  now explicitly banned: cream canvas with a terracotta accent reads as Anthropic's
  own palette, and serif prose on a warm background is the loudest machine-written
  tell there is. Both are gone.
  - Three palettes behind `data-p`, **slate** shipping: monochrome, with `--flag`
    the only chromatic mark in the view so it can mean "risk" and nothing else.
    Interaction is carried by weight, underline and background shift.
  - Two families, no serif anywhere. Nothing renders below 13px; prose is 16/1.62
    at a **64ch measure that holds at 3840px**. Inline code has no chip, box or
    padding — mono at 0.92em in the inherited colour.
  - 1px borders (not sub-pixel), radii 3px/5px, and **one level of nesting**: the
    reading column sits directly on the canvas and callouts are a 2px left rule.
    Only the tab strip, the two rails and the bottom strip are surfaces.
  - The row of metric cards is gone — one line of tabular numerals instead.
  - Two tokens moved for contrast, both because the specified values break the
    system's own 10–14:1 ceiling: slate `--ink` `#15181B` → `#282D31` (15.6 → 12.2)
    and bond `--ink` `#191919` → `#2F2F2E` (17.0 → 12.9). Graphite already complied
    at 13.8, and `--mark` keeps its original value — it is a signal, not body text.
  - `⇧A` marks every file read; `t` cycles palette.
- `tests/design.mjs` now gates all three palettes on: no stray hex, no serif, no
  metric cards, no gradient or blur, weights, radii, the 13px floor, one nesting
  level, bare inline code, the 64ch measure at 3840px, the three contrast floors,
  and the guard that no literal `<code>` string ever reaches the DOM.

- (superseded) The viewer follows the paper design system: warm paper canvas, two
  chromatic accents only (pine `--accent`, ember `--flag`), hairline separation
  instead of shadows, radii capped at 6px, weights 400/500, sentence case, three
  type roles (sans chrome / mono identifiers / serif prose at a 66ch measure),
  and 140ms ease-out limited to hover and disclosure with `prefers-reduced-motion`
  honoured. Every hex now lives in the token block; the old names (`--bg`,
  `--surface`, `--muted`, …) survive as aliases so no rule resolves to a stale
  literal.
  - **Diff colours are colourblind-safe by default** (blue / terracotta) with the
    classic red/green available as a setting, persisted per reader.
  - Deviations, both because the alternative loses information:
    **(1)** the eight-hue group palette became a tonal ladder — group identity is
    carried by the group's name and its band, since eight hues would be six more
    accents than the system allows; **(2)** the per-language colour dots are gone,
    labels only, for the same reason.
  - One token changed: `--ink` `#1E1C19` → `#2D2A26`. The specified value measures
    15.5:1 on `--canvas`, above the 10–14:1 band the system's own checklist sets;
    the new value lands at 13.0:1, which is the "~13:1" its comment asks for.
- **Reading-session features.** Per-file read state, a footer strip with a 2px
  progress bar, focus mode, restored tab/scroll/settings, and a keyboard path to
  every action — `j`/`k` step, `]`/`[` file, `s` mark read, `n` first question,
  `f` focus, `g`/`G` ends, `1`–`7` tabs, `t` theme, `?` sheet. The shortcut sheet
  and the settings live in the `?` dialog.
- `tests/design.mjs` enforces the parts of the system a script can decide — no
  stray hex, weights, radii, no non-overlay shadow, serif prose measure, and the
  body contrast band — in **both** themes.

- **The inspector collapses on the tabs that never write to it.** It cost ~40% of
  the width permanently while its idle state was a group legend duplicating the
  page title and the Files tab's colors. Now it is present on Logic, Diagrams and
  Files, and Standards / Tests / Ops / User stories get the full width — which also
  un-cramps the two-column Tests pane. Collapsing had to be reversible: Standards
  and Tests carry `data-goto` links *into* the inspector, so a file click from any
  tab reveals it again, and "back" on a prose tab gives the width back instead of
  rendering the legend. No new affordance — the loop closes with the controls that
  were already there.

## [0.6.0] — 2026-08-05

Continues 0.5.0: cutting what the model generates, since a pass's wall-clock is
set by output volume and nothing else. Measured across three shards of one
instrumented run, all three wrote at 102–119 bytes/sec.

### Added
- **`scripts/shards.mjs`** — plans the classifier split against a wall-clock
  budget instead of by service area. Splitting by area produced a 17× imbalance
  on the reference run (5 KB in one shard, 86 KB in another) with everything
  waiting on the big one. The planner weights each file, packs longest-first into
  balanced shards, adds shards until the slowest fits, and says plainly when no
  split can fit — that means the input is too big, not the split wrong. Weights
  are calibrated on the reference run (predicted 166 KB against 173 KB measured)
  and adjustable via `--rate`, `--per-file`, `--per-substantive`.
- `tests/shards.mjs` — balance, full coverage, `--skip`, and budget overflow.

### Changed
- **Code fragments are lifted from the patch, not retyped by the model.** The
  classifier no longer emits `frag` or `preview`; `merge.mjs` extracts them in a
  single indexed scan of the patch — 107 fragments out of a 52 MB patch in 0.3s,
  replacing ~32 KB the model used to generate. It picks the hunk with the most
  changed code (not merely the first, which tends to be file-top boilerplate) and
  starts the window at real code rather than a docblock.
- **`fragAnchor`** — a new optional per-file field: a short distinctive string
  from the line worth showing. A dozen characters instead of a dozen lines, for
  the case the heuristic cannot get right — one small important change in a file
  that also gained a large unrelated block.
- **Group metadata is authored once.** `narrative.json` carries the group list
  (`id`, `name`, `role`, `why`) and shards emit `{id, files}`. Previously every
  shard re-authored the same groups, and could describe one group three different
  ways. A group nobody assigned a file to is dropped.
- `narrative.json` gains `skip` — files that get no code fragment.

## [0.5.0] — 2026-08-05

Performance. A 29m20s run was measured event by event from the session
transcripts; two of its blocks were duplicated work, not analysis.

### Changed
- **Agents write their own output files.** Each analysis pass gets a `Write` tool
  and an `OUT:` path in `.whydiff/`, writes its JSON there and replies with one
  confirmation line. Previously an agent returned its JSON in the reply and the
  orchestrator retyped it into a file — a second full generation of the same
  text. Measured on the reference run: 6m53s for 79 KB across three files, while
  the one answer that was copied by script instead took 9 seconds.
- **`scripts/merge.mjs` replaces hand-rolled merging.** It re-collects the
  manifest from git, unifies the classifier shards, takes `add`/`del`/`isNew`
  from git rather than from the model, holds every file to exactly one group,
  prunes edges whose ends did not survive, validates, and refuses to write a map
  that would not validate. The orchestrator now authors only
  `.whydiff/narrative.json` (meta, intent, story, `embedFull`). On the reference
  run, improvising this merge cost 3m30s including two failed attempts.
- The classifier no longer emits `add`/`del`/`isNew` per file — `merge.mjs` fills
  them from git, so those bytes were being generated and then discarded.

### Fixed
- The manifest excludes the pipeline's own `.whydiff/` directory, so a repo that
  does not `.gitignore` it no longer gets a map that reviews its own scratch
  files. On the reference run 8 such files reached the map, including its own
  `diff.patch` and `review-map.json`, and caused the single validation error that
  cost 2m01s to chase.
- The timing report no longer drops a phase whose boundary event was never
  logged. Missing phases are marked `not measured` and the remainder is reported
  as `Unattributed`, with the names of the missing events. Previously 83% of a
  run could vanish from the phase table while the totals still looked complete.
- The report now accounts for HTML assembly as its own phase.

## [0.4.1] — 2026-08-05

### Development (no change to plugin behavior)
- `Makefile` with the local development loop: `make check` (contract + viewer +
  manifest checks, no LLM), `make preview`, `make fixtures`, `make run-<name>`
  (prepares a fixture and opens Claude with the working tree via
  `--plugin-dir`), `make report-<name>`, `make map-<name>`, `make clean-fixtures`.
- `tests/fixtures/`: fixture projects for end-to-end runs before pushing.
  `synthetic` is generated locally (10 files across TS/PHP/SQL/MD with a schema
  migration that adds a table and renames a column); `quick`, `feature`,
  `migration` and `big` are real commits from expressjs/express, honojs/hono,
  zulip/zulip and mastodon/mastodon, pinned by SHA and fetched with `--depth 2`.
  Each fixture's recorded GitHub stats are cross-checked against our own
  manifest, so preparing one also tests `manifest.mjs` in ref mode.

## [0.4.0] — 2026-08-05

### Added
- **Scope bar**: logical scope tags (`backend`, `frontend`, `api`, `docs`, …)
  with file counts above the tabs — one glance shows which parts of the
  project a change touches. Clicking a tag jumps to the Files tab and dims
  everything outside that scope. `service` is now required for every file in
  the contract, and the classifier must keep the tags consistent.
- **Language indicators**: language dots/badges in GitHub-linguist colors,
  aggregated in the scope bar and per file card (TS, JS, PHP, PY, SQL, …).
- **Diagram viewing**: every diagram gets a fullscreen button (`⛶`, uses the
  whole viewport) and a pop-out button (`⧉`, opens the rendered SVG alone in a
  new window) — large graphs are readable without squinting at a column.
- **Permission hook** (`hooks/hooks.json` + `scripts/approve.mjs`): a
  `PreToolUse` hook auto-approves only the pipeline's own operations — bundled
  scripts, read-only git, writes into `.whydiff/`, opening the built map — so a
  run no longer needs a dozen confirmations. Chained/substituted commands
  (`;`, `&`, `|`, backticks, `$(`) are never auto-approved; everything else
  falls through to the normal permission flow.

### Changed
- Project description sharpened everywhere (README, manifests, skill): whydiff
  is for following the *meaning* of a change — its architectural and logical
  decisions — without reading every file an LLM touched.
- README: added a "What the map answers" table mapping reviewer questions to
  tabs.

## [0.3.0] — 2026-08-04

### Added
- `er-diff` diagram kind: when the diff contains schema-changing migrations,
  the diagrammer must produce a mermaid `erDiagram` of the affected tables
  (diff marking via attribute comments: `"+ added"` / `"- removed"` /
  `"~ was: …"`), only the affected tables and their direct relations.

### Changed
- Viewer: the "How to read this map" prose moved out of the default inspector
  into a help dialog (the `?` button in the tabs row and a link under the
  legend). The default inspector is now a compact clickable group legend with
  reviewer roles and the completeness line.

## [0.2.0] — 2026-08-04

### Added
- Timing instrumentation for every `/whydiff` run: `scripts/timing.mjs` logs
  pipeline events to `.whydiff/timing.jsonl` (script-side timestamps;
  `validate.mjs`/`assemble.mjs` log their events automatically) and
  `timing.mjs report` renders `.whydiff/timing-report.md` — a per-phase
  wall-clock breakdown with artifact sizes, meant to be shared when
  discussing performance. Measurement only: analysis steps are unchanged.

## [0.1.0] — 2026-08-04

First public release.

### Added
- `/whydiff` skill: builds an interactive review map for a git diff
  (working tree, revision range, or PR) via four parallel analysis agents
  (classifier, diagrammer, standards-reviewer, tests-analyst).
- `review-map.json` contract (`schema/review-map.schema.json`) between the
  generator and the viewer; completeness is enforced by script
  (`scripts/validate.mjs` cross-checks the manifest against the real
  `git diff --numstat`), never asserted by the LLM.
- Self-contained HTML viewer (`templates/viewer.html`): causal story,
  cause-grouped file map with labeled edges, standards/tests/ops tabs,
  drill-down inspector with code fragments and full files, en/ru i18n,
  light/dark themes, inlined mermaid bundle.
- Clickable diff-marked mermaid diagrams: `click <id> call whydiffOpen("<path>")`
  opens the file in the inspector; click targets are validated against the diff.
- Repo doubles as a plugin marketplace (`.claude-plugin/marketplace.json`):
  `/plugin marketplace add smagew/whydiff` + `/plugin install whydiff@whydiff`.
