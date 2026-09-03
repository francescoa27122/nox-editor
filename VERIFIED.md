# Verification notes for fixes without a test

## A5-012

A one-row edit to the Known debt table in `ARCHITECTURE.md` §7, so there is
nothing a test can hold. Verified by re-deriving each claim the new sentence
makes against the code at this commit:

- `src/platform/tauri.ts` sets `customWindowControls` on Windows, and
  `src/ui/TitleBar.svelte` draws the "Close window" button only under
  `drawWindowControls`, which reads that capability.
- `src-tauri/src/window_state.rs` handles `WindowEvent::CloseRequested`, which
  is the path both the drawn control (`platform.closeWindow()`) and Alt+F4
  arrive through.
- The macOS half of the sentence is unchanged from the row as it was.

The Linux case (decorations on, so the window manager's own control) is not
claimed in the row, as the audit noted it was read rather than run.
