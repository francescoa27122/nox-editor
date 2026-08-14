# Screenshots

Referenced by the top-level README.

| File | What it shows |
|---|---|
| `editor.png` | The editor with the explorer open on Nox's own source |
| `review.png` | The review panel: a change an agent proposed, before it is applied |

## Retaking them

Capture the window by its id rather than a screen region — it ignores whatever
is stacked on top, and macOS adds the drop shadow for you:

```bash
screencapture -x -l$(scripts/window-id Nox) docs/screenshots/editor.png
```

`scripts/window-id` is a few lines of Swift that asks the window server for the
first window belonging to a named app. It needs Screen Recording permission
for whichever terminal you run it from; nothing else.
