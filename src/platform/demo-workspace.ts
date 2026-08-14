/**
 * A small, realistic project used to seed the browser dev target so Nox has
 * something to show on first launch. Not shipped in the desktop build.
 */

export const DEMO_ROOT = '/home/nox/projects/aurora';

const files: Record<string, string> = {
  'README.md': `# Aurora

A tiny demo workspace that ships with the Nox browser build.

## Why this exists

Running \`npm run dev\` should give you a *usable* editor immediately — not an
empty window with a "no folder open" placeholder. Everything here is in-memory:
edit freely, nothing touches your disk.

- Press \`⌘K\` for the command palette
- Press \`⌘P\` to jump to a file
- Press \`⌘F\` to search this buffer

> Nox — Latin for *night*.
`,

  'package.json': `{
  "name": "aurora",
  "version": "0.3.1",
  "type": "module",
  "scripts": {
    "dev": "aurora serve --watch",
    "build": "aurora build --minify",
    "test": "vitest run"
  },
  "dependencies": {
    "nanoid": "^5.0.7"
  }
}
`,

  'src/index.ts': `import { createScheduler, type Task } from './scheduler';
import { Telemetry } from './telemetry';

/**
 * Aurora entry point. Boots the scheduler, wires telemetry, and blocks
 * until the process receives a shutdown signal.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const verbose = argv.includes('--verbose');
  const telemetry = new Telemetry({ enabled: !argv.includes('--no-telemetry') });
  const scheduler = createScheduler({ concurrency: 8, onError: (e) => telemetry.error(e) });

  const tasks: Task[] = [
    { id: 'index', priority: 10, run: async () => indexWorkspace() },
    { id: 'watch', priority: 5, run: async () => watchFiles() },
  ];

  for (const task of tasks) scheduler.enqueue(task);

  if (verbose) {
    console.log(\`aurora: \${tasks.length} tasks queued at \${new Date().toISOString()}\`);
  }

  const code = await scheduler.drain();
  await telemetry.flush();
  return code;
}

async function indexWorkspace(): Promise<void> {
  // Walk the tree once, then hand off to the incremental watcher.
  for await (const entry of walk('.')) {
    if (entry.isDirectory || entry.size > 4_000_000) continue;
    await index(entry.path);
  }
}
`,

  'src/scheduler.ts': `export interface Task {
  id: string;
  priority: number;
  run: () => Promise<void>;
}

interface SchedulerOptions {
  concurrency: number;
  onError?: (error: unknown) => void;
}

/**
 * A priority queue with bounded concurrency. Higher priority runs first;
 * ties break by insertion order so behaviour stays deterministic.
 */
export function createScheduler({ concurrency, onError }: SchedulerOptions) {
  const queue: Task[] = [];
  let running = 0;
  let seq = 0;
  const order = new WeakMap<Task, number>();

  function enqueue(task: Task): void {
    order.set(task, seq++);
    queue.push(task);
    queue.sort((a, b) => b.priority - a.priority || order.get(a)! - order.get(b)!);
    pump();
  }

  function pump(): void {
    while (running < concurrency && queue.length > 0) {
      const task = queue.shift()!;
      running++;
      task.run()
        .catch((error) => onError?.(error))
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  async function drain(): Promise<number> {
    while (running > 0 || queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    return 0;
  }

  return { enqueue, drain, get pending() { return queue.length; } };
}
`,

  'src/telemetry.ts': `type Level = 'debug' | 'info' | 'warn' | 'error';

interface Event {
  level: Level;
  message: string;
  at: number;
}

export class Telemetry {
  #buffer: Event[] = [];
  #enabled: boolean;

  constructor({ enabled = true }: { enabled?: boolean } = {}) {
    this.#enabled = enabled;
  }

  error(payload: unknown): void {
    const message = payload instanceof Error ? payload.message : String(payload);
    this.#push('error', message);
  }

  #push(level: Level, message: string): void {
    if (!this.#enabled) return;
    this.#buffer.push({ level, message, at: Date.now() });
    if (this.#buffer.length > 512) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer.splice(0, this.#buffer.length);
    await fetch('https://telemetry.invalid/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    }).catch(() => undefined);
  }
}
`,

  'src/ui/theme.css': `:root {
  --aurora-bg: #0b0e14;
  --aurora-fg: #c8d2e4;
  --aurora-accent: #7dd3e0;
  --aurora-radius: 6px;
}

.panel {
  background: var(--aurora-bg);
  color: var(--aurora-fg);
  border-radius: var(--aurora-radius);
  padding: 16px 20px;
  transition: background 130ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

.panel:hover {
  background: color-mix(in oklab, var(--aurora-bg) 92%, white);
}
`,

  'src/ui/panel.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Aurora — Panel</title>
    <link rel="stylesheet" href="./theme.css" />
  </head>
  <body>
    <main class="panel" role="main">
      <h1>Aurora</h1>
      <p>Scheduler status: <strong data-bind="status">idle</strong></p>
    </main>
  </body>
</html>
`,

  'scripts/bench.py': `"""Micro-benchmark for the Aurora scheduler."""

import statistics
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class Result:
    name: str
    samples: list[float]

    @property
    def median(self) -> float:
        return statistics.median(self.samples)

    def report(self) -> str:
        p95 = sorted(self.samples)[int(len(self.samples) * 0.95)]
        return f"{self.name:<24} median={self.median * 1000:7.2f}ms  p95={p95 * 1000:7.2f}ms"


def bench(name: str, fn, runs: int = 200) -> Result:
    samples = []
    for _ in range(runs):
        start = time.perf_counter()
        fn()
        samples.append(time.perf_counter() - start)
    return Result(name, samples)


if __name__ == "__main__":
    for result in (bench("enqueue", lambda: None), bench("drain", lambda: None)):
        print(result.report())
`,

  'crates/core/src/lib.rs': `//! Aurora core — the parts that need to be fast.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: PathBuf,
    pub size: u64,
    pub is_dir: bool,
}

/// Walk \`root\` breadth-first, skipping anything the ignore list matches.
pub fn walk(root: &Path, ignore: &[&str]) -> std::io::Result<Vec<Entry>> {
    let mut out = Vec::new();
    let mut queue = vec![root.to_path_buf()];

    while let Some(dir) = queue.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();

            if ignore.iter().any(|pattern| name.as_ref() == *pattern) {
                continue;
            }

            let meta = entry.metadata()?;
            if meta.is_dir() {
                queue.push(entry.path());
            }

            out.push(Entry {
                path: entry.path(),
                size: meta.len(),
                is_dir: meta.is_dir(),
            });
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_by_extension() {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        counts.entry("rs".into()).and_modify(|n| *n += 1).or_insert(1);
        assert_eq!(counts["rs"], 1);
    }
}
`,

  'config/aurora.json': `{
  "$schema": "https://aurora.invalid/schema/v1.json",
  "concurrency": 8,
  "watch": true,
  "ignore": ["node_modules", ".git", "target", "dist"],
  "limits": {
    "maxFileSize": 4000000,
    "maxDepth": 24
  },
  "telemetry": {
    "enabled": false,
    "endpoint": null
  }
}
`,

  'docs/notes.md': `# Engineering notes

## Scheduling

The queue is a plain array kept sorted on insert. That is \`O(n log n)\` per
enqueue, which sounds bad and is completely irrelevant: \`n\` peaks around 40.
Revisit only if a profile says so.

## Open questions

1. Should \`drain()\` reject on the first task failure, or collect?
2. Is a 4 MB file cap too aggressive for generated sources?

| Area      | Owner | Status      |
|-----------|-------|-------------|
| scheduler | —     | stable      |
| telemetry | —     | needs tests |
| walker    | —     | in progress |
`,

  '.gitignore': `node_modules/
dist/
target/
*.log
.DS_Store
`,
};

export const DEMO_WORKSPACE: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([relative, contents]) => [`${DEMO_ROOT}/${relative}`, contents]),
);
