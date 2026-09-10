# Submit checklist (human)

1. Rebuild from the fixed worktree (not `main`):
   `cd ~/Projects/intake-1a-extension/.claude/worktrees/review-queue-signal`
   `npm test && npm run build`
2. Chrome → Load unpacked → select that worktree's `dist/`.
3. Record 2–3 minutes unedited on Mock A with the side panel visible
   (gate + progress). Prefer a clean study (`?reset=1` if the mock supports it).
4. Optional but valuable: run Mock A a **second** time on the same study and
   note that existing visits/forms/fields are adopted (idempotency). Code path
   exists; live second-pass not re-proven this week.
5. Push branch (currently **no upstream**):
   `git push -u origin fix/skip-logic-and-formula-writes`
   then open a PR or zip per the brief.
6. Keep write-up honest: strong Mock A + known hostile failure families.
   **Do not claim ~70% on unseen.**
7. Evidence already staged under worktree `docs/`:
   - `GENERALIZATION_EVIDENCE.md`
   - `after-live-run-skipfix4.json`
   - `generalization-runs/` best scores (+ `submit-package-scores.tgz`)
8. Replace root `README.md` with content from `README.SUBMIT.md` (on box /
   after copy) once you review it.
