---
name: whydiff-work
description: Do the work agreed in a whydiff review — the tasks the reviewer opened from the change map (instructions they gave, or fix options they chose) — one at a time, recording each result in the review journal. Use when the user pastes a "Work the whydiff review queue" prompt, or asks to work the whydiff queue / do the agreed review tasks / continue a whydiff task.
---

# whydiff-work: drain the review queue

The reviewer read a change map, discussed parts of it with you, and agreed on work:
instructions they gave, and fix options they chose. Those decisions are in a
**review journal** — an append-only log next to the map — and this skill is the
other half of that loop: turn agreed tasks into actual changes, and record what
happened where the reviewer will see it.

**What makes this different from "just do the task":** every task carries an
*acceptance criterion* the reviewer approved, and a discussion that produced it.
Read the discussion before touching code, deliver exactly the agreed scope, and
never claim more than you can show.

## The journal

`<repo>/.whydiff/review.log.jsonl`, driven only through the bundled script — it is
append-only, and hand-editing it corrupts a record the reviewer relies on:

```bash
R="node ${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs <repo>/.whydiff"
$R                                     # where the review stands
$R --next                              # the next task + the discussion behind it
$R --thread <taskId>                   # a specific task + its discussion
$R --start <taskId>                    # → in progress
$R --resolve <taskId> --patch <file> --files a,b
$R --verify <taskId> --evidence "<what ran, and its output>"
$R --report <taskId> --text "…"        # a note on the task's thread
$R --decline <taskId> --reason "…"     # only when the reviewer says so
```

Every write is validated by the journal, so a refused command means the record
would have been wrong — read the message rather than working around it.

If there is no journal, say so plainly: the queue is created by discussing a map in
`scripts/serve.mjs` (Instruct / Options in the report's panel). Do not invent tasks.

## Loop

**One task at a time**, oldest first, unless the user names one.

1. **Read the task**: `$R --next`. It gives the spec, the criterion, the anchored
   place, the files, and every remark made on that place.
2. **Claim it**: `$R --start <taskId>`, so the served page and any other session
   show it as taken rather than still waiting.
3. **Read before writing**: the discussion is the *context*; `review-map.json` is a
   model's analysis of the diff; the code is the only ground truth. When the code
   contradicts the map or the discussion, the code wins — and say so in your report.
4. **If the discussion contains an unanswered question that blocks the work**, do
   not guess: `$R --report <taskId> --text "blocked: <the question>"`, tell the user,
   and stop. A task built on a guess is worse than an unstarted one.
5. **Implement the agreed scope and nothing else.** The `spec` is the boundary. If
   the work turns out to require something outside it — a refactor, a dependency, a
   schema change nobody agreed to — stop, report it on the thread, and let the
   reviewer decide. Widening scope silently is exactly what the review exists to
   prevent.
6. **Capture the patch** so the reviewer can look at the change as a change:

   ```bash
   mkdir -p <repo>/.whydiff/tasks
   git -C <repo> diff HEAD -- <the files you touched> > <repo>/.whydiff/tasks/<taskId>.patch
   ```

   This is a diff against `HEAD`, so it is exact when the previous task was
   committed and cumulative per file when it was not. If two tasks touch the same
   file without a commit in between, say that in your report instead of pretending
   the patch is clean.

7. **Record it**: `$R --resolve <taskId> --patch <path> --files <the files>`. The
   task is now `done` — which means *changed*, not *proven*.

8. **Verification is earned, not asserted.** Only an `acceptance` of type `test` is
   yours to close, and only by actually running it:

   ```bash
   $R --verify <taskId> --evidence "npm test -- -t 'refund on unshipped order' → 1 passed, 0 failed"
   ```

   Evidence is the command and its real output. Never pass your own judgement there.
   - `story` / `finding` criteria are closed by regenerating the map (`/whydiff`)
     and seeing the story flip or the finding disappear — not by you.
   - `manual` is the reviewer's to close.
   - A test that fails is a result too: leave the task `done`, report the failure
     with its output, and do not touch the criterion.

9. **Report to the user** in the report's language: what changed, where the patch
   is, what the criterion now says, and what is left in the queue. If you skipped
   or stopped, say which task and why.

## Never

- Never mark a task `verified` from anything but a run you performed.
- Never work a `proposed` task (nobody agreed to it yet) or a `declined` one
  (someone decided against it) without the user asking for exactly that.
- Never edit `review.log.jsonl`, `review.json` or `threads.migrated.json` by hand.
- Never touch a task the user did not ask for while you are inside another one.
- Never commit or push unless the user asks. Source edits go through the normal
  permission flow — the plugin's hook only auto-approves its own scripts and writes
  inside `.whydiff/`.
