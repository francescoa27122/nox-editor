# Nox: rating after remediation

Companion to `AUDIT/RATING.md`, which holds the before state, the evidence and the full finding list. This file is the re-score against the same rubric.

## The number

**Before: 59 / 100.** Category scores summed to 64, and one unresolved P0 capped the total at 59.

**After: 78 / 100.** No P0 remains, so no cap applies.

That is a 19 point move, and 5 of it is the cap lifting rather than new quality. The honest reading is that the categories went from 64 to 78, and the P0 that made the cap apply is fixed and verified.

78 sits in the 75 to 89 band: "strong, real gaps, none of them blocking a public beta". That is a fair description of what is now on the branches. It is not 90: the agent boundary still rests on an enumerated list rather than a rule, the composition root is still a 5,000 line file, and the packaged app still has no signing and no crash reporter.

## Category table

| Category | Before | After | Max | What moved |
|---|---|---|---|---|
| Feature completeness and correctness | 13 | 17 | 20 | The P0 save race, the frozen tab strip, the dropped dirty tab and the cursor jump are all fixed and verified. The OS can now hand Nox a file. Eight languages added. Still short of 20: file associations and single instance are Gated, and there is no indentation detection. |
| Architecture and systems quality | 11 | 14 | 18 | 13 blocking IPC commands moved off the main thread, with the three ordering-sensitive writes correctly left alone. Reload now disposes. Child reaping went from 29.3 s to 0.09 s, measured. Still short: `app.ts` is larger than when the audit started, and A2-007 was deliberately not attempted. |
| Security and memory safety | 11 | 14 | 16 | The LSP header abort, the repository `core.fsmonitor` execution, the drive-relative config escape, the `localhost` resolution gap and the Windows shell fallback are all closed and independently re-verified, including an IPv6-only listener test that no escape spelling defeated. Still short: no `cargo audit` gate ran here, and the unix file-mode fix is CI-verified only. |
| Performance and multi-file editing | 8 | 12 | 14 | Sticky scroll is now O(depth), find no longer rescans on every dispatch or after closing, and the diff is bounded. Reverting them produced 21x and 71x regressions, so the guards are real. Still short: no large-file mode below the 64 MB refusal, which is Gated. |
| UI and UX | 11 | 13 | 14 | Both contrast failures fixed and independently recomputed to three decimals. The corrupted glyph, the platform key glyphs, the menu clipping, the live-region role and the accessible names are all done. Still short: Alt-to-open-menu and the editor focus trap are Gated. |
| AI agent integration readiness | 5 | 6 | 10 | A runaway agent is now bounded, the trail is exportable, hidden characters are revealed in review, children die with the host on exit, and the docs no longer overclaim. **The P1 is not fixed and is not mine to fix.** Upstream closed the twelve exploitable instances in its own review; the dispatcher rule that would close the class is Gated. |
| Ship readiness for public release | 5 | 7 | 8 | A release panic now leaves a trace, there is a disclosure route, licences are attributed, CI has scoped permissions and pinned actions, and the macOS floor is honest. Still short: the builds are still unsigned, which is the single largest remaining item. |
| **Total** | **64, capped to 59** | **78** | **100** | |

## What was actually done

| | Count |
|---|---|
| Findings fixed and verified | 69 |
| Gated, untouched, awaiting a decision | 11 |
| Safe but deliberately not attempted | 5 |
| New findings discovered during remediation | 3 |

Every fix ships a test that was run failing before and passing after. Seven pull requests, each green on all eleven required checks.

### The three findings found while fixing

1. **A8-013.** Raising the macOS floor to 13.0 surfaced two scrims using unprefixed `backdrop-filter`, which Safari shipped only in 18. Blur failed silently on macOS 13 through 17, inside the floor the same branch had just set. Fixed and held by a rule.
2. **`tasks.runLast` shipped untested.** The coverage test added for A1-012 caught an upstream command no test named. A test now pins that the remembered task is set after the approval, so a refused project task does not become the one Run Last Task repeats.
3. **A cross-branch failure no single branch could see.** A features test edited the active buffer around the live view. Harmless alone, it threw a `RangeError` once the performance branch's save-time formatting began routing through that view. Neither branch's CI could have caught it; the merged regression pass did.

## Verification performed

- Seven per-branch adversarial verification passes, one branch pair per agent. The security branch received two independent passes that agree.
- Every P0 and P1 fix mutation-checked: the fix reverted, the test confirmed to fail, the fix restored.
- Contrast numbers, licence rows, action SHAs and the Rust version floor all recomputed independently rather than taken from the reports. One overstated count was caught and corrected.
- A merged regression pass built all seven branches together, ran the full gate (2,770 tests, `test:editor`, clippy, cargo test, build) and walked eight core flows in a real browser, including the two the fixes made highest risk.

## What would move the score furthest now

1. **Sign the builds.** Ship readiness cannot reach 8 while both platforms interrupt the first run, and it is the first thing a stranger meets. This is a spend decision, not a code one.
2. **Decide A7-001.** A dispatcher rule refusing undeclared commands for non-user principals takes agent readiness from 6 toward 9 and closes A7-002 and A7-003 with it. Upstream's enumerated fix works today and pins the set with a test, so this is about the class, not the instances.
3. **Split the composition root.** A2-007 is the only Safe finding deliberately left. It is worth 2 to 3 points of architecture and it gets harder every release; the file grew during this audit.
4. **A large-file mode below 64 MB.** Gated, and the last real performance cliff.
5. **Persist the agent audit trail.** It is in memory, capped at 500, and lost on reload, which undercuts the one artefact the agent design offers as evidence.

## Where this could be wrong

- The score is a judgement against a rubric, not a measurement. The 19 point move is defensible; a reader who weighted the unsigned builds or the agent boundary harder could argue for 74.
- 5 of the 19 points are the cap lifting. Anyone who thinks a single P0 should not cap a total will read the move as 64 to 78.
- The unix file-mode fix (A6-006) and the macOS open handler (A1-001) have never executed on this machine. CI compiles and runs both, and that is the whole of the evidence for them.
- The desktop application was never packaged and walked during this audit. Every UI result comes from the browser build or a real Chromium test, and the packaged app's native chrome, its menus, dialogs, terminal and a real git repository, remains unexercised. That was already a Known-debt row and it still is.
