# Diff Viewer Performance Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix diff viewer performance so it handles multi-thousand-line diffs without freezing the browser or blocking the server.

**Architecture:** Replace raw DOM rendering with `@tanstack/react-virtual` flat virtualized list. Convert backend `execSync` to async `Bun.spawn` for the diff endpoint. Add `structuralSharing` to React Query to avoid re-parse when diff content is unchanged. Pre-compute CSS class strings to eliminate per-line `cn()` calls.

**Tech Stack:** @tanstack/react-virtual (already installed), Bun.spawn, TanStack React Query

---

### Task 1: Add async git helper (`gitExecAsync`)

The existing `gitExec` uses `execSync` which blocks the Bun event loop. Add an async variant used by the hot `/diff` endpoint.

**Files:**
- Modify: `server/routes/git.ts:1-30`

**Step 1: Add `gitExecAsync` function after the existing `gitExec`**

Add this function right after the existing `gitExec` (after line 30):

```typescript
// Async git command execution using Bun.spawn — does not block the event loop
async function gitExecAsync(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const timeoutId = setTimeout(() => proc.kill(), timeoutMs)

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    clearTimeout(timeoutId)

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `git ${args.join(' ')} exited with code ${exitCode}`)
    }
    return stdout.trim()
  } catch (err) {
    clearTimeout(timeoutId)
    throw err
  }
}
```

**Step 2: Convert the `/diff` handler to async**

Change `app.get('/diff', (c) => {` (line 462) to `app.get('/diff', async (c) => {` and replace all `gitExec(...)` calls inside it with `await gitExecAsync(...)`. The `gitExecAsync` takes an **array** of args instead of a single string.

Specific replacements inside the `/diff` handler:

| Old | New |
|-----|-----|
| `gitExec(worktreePath, diffArgs)` | `await gitExecAsync(worktreePath, staged ? ['diff', '--cached', ...(ignoreWhitespace ? ['-w'] : [])] : ['diff', ...(ignoreWhitespace ? ['-w'] : [])])` |
| `gitExec(worktreePath, 'status --short', 10_000)` | `await gitExecAsync(worktreePath, ['status', '--short'], 10_000)` |
| `gitExec(worktreePath, 'rev-parse --abbrev-ref HEAD')` | `await gitExecAsync(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])` |
| `getDefaultBranch(worktreePath, baseBranchParam)` | Keep sync — this is only called on the fallback path when there's no local diff, and modifying `getDefaultBranch` to be async would cascade into many other endpoints (sync, merge-to-main, etc.). The blocking cost is small (a few ms for `rev-parse --verify`). |
| `gitExec(worktreePath, \`merge-base ${baseBranch} HEAD\`)` | `await gitExecAsync(worktreePath, ['merge-base', baseBranch, 'HEAD'])` |
| `gitExec(worktreePath, \`diff${wsFlag} ${mergeBase}..HEAD\`)` | `await gitExecAsync(worktreePath, ['diff', ...(ignoreWhitespace ? ['-w'] : []), \`${mergeBase}..HEAD\`])` |

Do NOT touch `gitExec` usages in any other route handler — they are not in the hot polling path and share code with sync helpers like `getDefaultBranch`, `checkUncommittedChanges`, `performSquashMerge`.

**Step 3: Run the build to verify no type errors**

Run: `mise run build`
Expected: Build succeeds with no errors

**Step 4: Commit**

```bash
git add server/routes/git.ts
git commit -m "perf: add async gitExecAsync and convert /diff handler to non-blocking"
```

---

### Task 2: Smarter polling in `useGitDiff`

The current `refetchInterval: 5000` polls unconditionally. Add `structuralSharing` (already default in React Query, but verify), and reduce wasted re-renders by making the interval conditional on document visibility.

**Files:**
- Modify: `frontend/hooks/use-filesystem.ts:79-96`

**Step 1: Update `useGitDiff` to use visibility-aware polling**

Replace the current `useGitDiff` function (lines 79-96) with:

```typescript
export function useGitDiff(worktreePath: string | null, options: { staged?: boolean; ignoreWhitespace?: boolean; includeUntracked?: boolean; baseBranch?: string } = {}) {
  const { staged = false, ignoreWhitespace = false, includeUntracked = false, baseBranch } = options
  return useQuery({
    queryKey: ['git', 'diff', worktreePath, staged, ignoreWhitespace, includeUntracked, baseBranch],
    queryFn: () => {
      const params = new URLSearchParams({
        path: worktreePath!,
        ...(staged && { staged: 'true' }),
        ...(ignoreWhitespace && { ignoreWhitespace: 'true' }),
        ...(includeUntracked && { includeUntracked: 'true' }),
        ...(baseBranch && { baseBranch }),
      })
      return fetchJSON<GitDiff>(`${API_BASE}/api/git/diff?${params}`)
    },
    enabled: !!worktreePath,
    refetchInterval: 5000,
    refetchIntervalInBackground: false, // Stop polling when tab is not visible
  })
}
```

The key addition: `refetchIntervalInBackground: false`. React Query's `structuralSharing` is on by default, so if the response JSON is deeply equal, it returns the same reference and downstream `useMemo` won't re-compute.

**Step 2: Apply the same fix to `useGitStatus`**

Add `refetchIntervalInBackground: false` to the `useGitStatus` query options (line 107).

**Step 3: Run build**

Run: `mise run build`
Expected: Success

**Step 4: Commit**

```bash
git add frontend/hooks/use-filesystem.ts
git commit -m "perf: stop polling git diff/status when tab is not visible"
```

---

### Task 3: Virtualize the diff viewer

This is the biggest performance win. Replace the current "render every line as a DOM node" approach with a flat virtualized list using `@tanstack/react-virtual`.

**Files:**
- Modify: `frontend/components/viewer/diff-viewer.tsx` (full rewrite of rendering logic)

**Step 1: Rewrite `diff-viewer.tsx`**

The strategy:
- Flatten `FileDiff[]` into a single array of `FlatRow` items (file-header rows + diff-line rows)
- When a file is collapsed, only its header row is in the flat list
- Use `useVirtualizer` to render only visible rows
- Pre-compute CSS class strings per line type instead of calling `cn()` per row
- Replace `<ScrollArea>` with a plain `div` with `overflow-y: auto` (react-virtual needs a direct ref to the scrollable element)
- Replace the `<Collapsible>` component (was rendering all lines into DOM) with click-toggle on file-header rows

Replace the **entire file** content with:

```tsx
import { useEffect, useMemo, useRef, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowRight01Icon, ArrowDown01Icon, MenuCollapseIcon, UnfoldMoreIcon } from '@hugeicons/core-free-icons'
import { useGitDiff } from '@/hooks/use-filesystem'
import { useDiffOptions } from '@/hooks/use-diff-options'
import { cn } from '@/lib/utils'

interface DiffLine {
  type: 'header' | 'hunk' | 'added' | 'removed' | 'context'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

interface FileDiff {
  path: string
  lines: DiffLine[]
  additions: number
  deletions: number
}

function parseDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = []
  let currentFile: FileDiff | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.+?) b\//)
      const path = match?.[1] ?? 'unknown'
      currentFile = { path, lines: [], additions: 0, deletions: 0 }
      files.push(currentFile)
      currentFile.lines.push({ type: 'header', content: line })
    } else if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      currentFile?.lines.push({ type: 'header', content: line })
    } else if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
      }
      currentFile?.lines.push({ type: 'hunk', content: line })
    } else if (line.startsWith('+')) {
      if (currentFile) {
        currentFile.additions++
        currentFile.lines.push({
          type: 'added',
          content: line.slice(1),
          newLineNumber: newLine++,
        })
      }
    } else if (line.startsWith('-')) {
      if (currentFile) {
        currentFile.deletions++
        currentFile.lines.push({
          type: 'removed',
          content: line.slice(1),
          oldLineNumber: oldLine++,
        })
      }
    } else if (line.startsWith(' ')) {
      currentFile?.lines.push({
        type: 'context',
        content: line.slice(1),
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
      })
    }
  }

  return files
}

// ── Pre-computed class strings to avoid cn() calls per row ──

const ROW_BASE = 'flex px-2 py-0.5'
const ROW_CLASSES: Record<DiffLine['type'], string> = {
  added: `${ROW_BASE} bg-diff-add-bg`,
  removed: `${ROW_BASE} bg-diff-remove-bg`,
  header: `${ROW_BASE} bg-muted/50 text-muted-foreground`,
  hunk: `${ROW_BASE} bg-diff-add-bg/50 text-diff-add-fg`,
  context: ROW_BASE,
}

const SIGN_BASE = 'w-4 shrink-0 select-none text-center'
const SIGN_CLASSES: Record<string, string> = {
  added: `${SIGN_BASE} text-diff-add-fg`,
  removed: `${SIGN_BASE} text-diff-remove-fg`,
  other: SIGN_BASE,
}

function getContentClass(type: DiffLine['type'], wrap: boolean): string {
  const base = wrap ? 'flex-1 whitespace-pre-wrap break-all' : 'flex-1 whitespace-pre'
  if (type === 'added') return `${base} text-diff-add-fg`
  if (type === 'removed') return `${base} text-diff-remove-fg`
  return base
}

// ── Flat row types for the virtual list ──

type FlatRow =
  | { kind: 'file-header'; file: FileDiff; collapsed: boolean }
  | { kind: 'diff-line'; line: DiffLine }

const FILE_HEADER_HEIGHT = 32
const DIFF_LINE_HEIGHT = 22

interface DiffViewerProps {
  taskId: string
  worktreePath: string | null
  baseBranch?: string
}

export function DiffViewer({ taskId, worktreePath, baseBranch }: DiffViewerProps) {
  const { options, setOption, toggleFileCollapse, collapseAll, expandAll, isFileCollapsed } = useDiffOptions(taskId)
  const { wrap, ignoreWhitespace, includeUntracked, collapsedFiles } = options
  const { data, isLoading, error } = useGitDiff(worktreePath, { ignoreWhitespace, includeUntracked, baseBranch })

  const files = useMemo(() => {
    if (!data?.diff) return []
    return parseDiff(data.diff)
  }, [data?.diff])

  const collapsedSet = useMemo(() => new Set(collapsedFiles), [collapsedFiles])

  const allFilePaths = useMemo(() => files.map(f => f.path), [files])
  const allCollapsed = files.length > 0 && collapsedFiles.length === files.length
  const totalAdditions = useMemo(() => files.reduce((sum, f) => sum + f.additions, 0), [files])
  const totalDeletions = useMemo(() => files.reduce((sum, f) => sum + f.deletions, 0), [files])

  // Build the flat row list — file headers + expanded file lines
  const flatRows: FlatRow[] = useMemo(() => {
    const rows: FlatRow[] = []
    for (const file of files) {
      const collapsed = collapsedSet.has(file.path)
      rows.push({ kind: 'file-header', file, collapsed })
      if (!collapsed) {
        // Skip the first header line (the "diff --git" line) — info is in the file header row
        for (let i = 1; i < file.lines.length; i++) {
          rows.push({ kind: 'diff-line', line: file.lines[i] })
        }
      }
    }
    return rows
  }, [files, collapsedSet])

  // Virtualizer
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      flatRows[index].kind === 'file-header' ? FILE_HEADER_HEIGHT : DIFF_LINE_HEIGHT,
    overscan: 40,
  })

  // Keyboard shortcut: Shift+C to toggle collapse/expand all
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'C' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
          return
        }
        e.preventDefault()
        if (allCollapsed) {
          expandAll()
        } else {
          collapseAll(allFilePaths)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [allCollapsed, allFilePaths, collapseAll, expandAll])

  if (!worktreePath) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No worktree selected
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading diff...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm">
        {error.message}
      </div>
    )
  }

  const hasUntrackedFiles = data?.files?.some(f => f.status === 'untracked') ?? false

  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground text-sm gap-2">
        <p>No changes detected</p>
        {data?.files && data.files.length > 0 && (
          <div className="text-xs">
            <p className="text-center mb-2">Modified files:</p>
            <div className="flex flex-col gap-1">
              {data.files.map((f) => (
                <div key={f.path} className="flex gap-2">
                  <span className={cn(
                    'w-4 text-center',
                    f.status === 'added' && 'text-diff-add-fg',
                    f.status === 'deleted' && 'text-diff-remove-fg',
                    f.status === 'modified' && 'text-muted-foreground',
                    f.status === 'untracked' && 'text-muted-foreground'
                  )}>
                    {f.status === 'added' && 'A'}
                    {f.status === 'deleted' && 'D'}
                    {f.status === 'modified' && 'M'}
                    {f.status === 'untracked' && '?'}
                  </span>
                  <span>{f.path}</span>
                </div>
              ))}
              {hasUntrackedFiles && (
                <label className="flex items-center gap-2 cursor-pointer text-muted-foreground hover:text-foreground mt-1">
                  <input
                    type="checkbox"
                    checked={includeUntracked}
                    onChange={(e) => setOption('includeUntracked', e.target.checked)}
                    className="w-4 h-3"
                  />
                  <span>Show untracked files</span>
                </label>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-2 py-1.5 bg-card border-b border-border text-xs">
        {data?.branch && (
          <span className="text-muted-foreground">
            {data.branch}
            {data.isBranchDiff && data.baseBranch && <span className="opacity-70"> (vs {data.baseBranch})</span>}
          </span>
        )}
        {(totalAdditions > 0 || totalDeletions > 0) && (
          <span className="text-muted-foreground">
            <span className="text-diff-add-fg">+{totalAdditions}</span>
            {' '}
            <span className="text-diff-remove-fg">-{totalDeletions}</span>
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => allCollapsed ? expandAll() : collapseAll(allFilePaths)}
          className="flex items-center gap-1 px-1.5 py-0.5 text-muted-foreground hover:text-foreground rounded hover:bg-muted/50"
          title={allCollapsed ? 'Expand all (Shift+C)' : 'Collapse all (Shift+C)'}
        >
          <HugeiconsIcon
            icon={allCollapsed ? UnfoldMoreIcon : MenuCollapseIcon}
            size={12}
            strokeWidth={2}
          />
          <span className="hidden sm:inline">{allCollapsed ? 'Expand' : 'Collapse'}</span>
        </button>
        <label className="flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => setOption('wrap', e.target.checked)}
            className="w-3 h-3"
          />
          Wrap
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground">
          <input
            type="checkbox"
            checked={ignoreWhitespace}
            onChange={(e) => setOption('ignoreWhitespace', e.target.checked)}
            className="w-3 h-3"
          />
          Ignore whitespace
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground">
          <input
            type="checkbox"
            checked={includeUntracked}
            onChange={(e) => setOption('includeUntracked', e.target.checked)}
            className="w-3 h-3"
          />
          Untracked
        </label>
      </div>

      {/* Virtualized diff content */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div
          className="relative w-full font-mono text-xs"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = flatRows[virtualRow.index]

            if (row.kind === 'file-header') {
              const { file, collapsed } = row
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 w-full"
                  style={{ top: virtualRow.start }}
                >
                  <div
                    className="flex items-center gap-2 px-2 py-1.5 bg-card border-b border-border cursor-pointer hover:bg-muted select-none"
                    onClick={() => toggleFileCollapse(file.path)}
                  >
                    <HugeiconsIcon
                      icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
                      size={12}
                      strokeWidth={2}
                      className="text-muted-foreground shrink-0"
                    />
                    <span className="font-mono text-xs text-foreground truncate flex-1">
                      {file.path}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {file.additions > 0 && (
                        <span className="text-diff-add-fg">+{file.additions}</span>
                      )}
                      {file.additions > 0 && file.deletions > 0 && ' '}
                      {file.deletions > 0 && (
                        <span className="text-diff-remove-fg">-{file.deletions}</span>
                      )}
                    </span>
                  </div>
                </div>
              )
            }

            const { line } = row
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 w-full"
                style={{ top: virtualRow.start }}
              >
                <div className={ROW_CLASSES[line.type]}>
                  {(line.type === 'added' ||
                    line.type === 'removed' ||
                    line.type === 'context') && (
                    <>
                      <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground">
                        {line.oldLineNumber ?? ''}
                      </span>
                      <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground">
                        {line.newLineNumber ?? ''}
                      </span>
                    </>
                  )}
                  <span className={SIGN_CLASSES[line.type] ?? SIGN_CLASSES.other}>
                    {line.type === 'added' && '+'}
                    {line.type === 'removed' && '-'}
                  </span>
                  <span className={getContentClass(line.type, wrap)}>
                    {line.content}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
```

Key changes from original:
- **`@tanstack/react-virtual`** — only visible rows are in the DOM (~40 overscan rows)
- **Pre-computed class maps** — `ROW_CLASSES`, `SIGN_CLASSES`, `getContentClass()` replace per-line `cn()` calls
- **`collapsedSet`** — `Set<string>` replaces `Array.includes()` for O(1) lookup
- **No `<ScrollArea>`** — replaced with plain `div` + `overflow-y: auto` (react-virtual needs direct ref)
- **No `<Collapsible>`** — file headers are just click-toggle rows in the flat list
- **`flatRows` memoized** — only recomputes when files or collapsedSet changes

**Step 2: Run the build**

Run: `mise run build`
Expected: Build succeeds. If there are unused import warnings for `ScrollArea`, `Collapsible`, `CollapsibleContent`, `CollapsibleTrigger`, those are expected — they're no longer imported.

**Step 3: Manual smoke test**

Open a task with a diff in the UI. Verify:
1. Diff loads and scrolls smoothly
2. File collapse/expand works
3. Shift+C toggles all
4. Toolbar checkboxes (wrap, whitespace, untracked) work
5. The scrollbar works (native browser scrollbar)

**Step 4: Commit**

```bash
git add frontend/components/viewer/diff-viewer.tsx
git commit -m "perf: virtualize diff viewer with @tanstack/react-virtual

Replaces full DOM rendering with a flat virtualized list.
A 10K-line diff now renders ~80 DOM nodes instead of ~75K.
Pre-computes CSS classes to eliminate per-line cn() calls.
Uses Set for O(1) collapsed file lookups."
```

---

### Task 4: Use `Set` for `collapsedFiles` in `useDiffOptions`

The diff viewer now uses `collapsedSet` internally, but the underlying `useDiffOptions` hook still creates new arrays on every toggle, causing unnecessary re-renders.

**Files:**
- Modify: `frontend/hooks/use-diff-options.ts`

**Step 1: Optimize `isFileCollapsed` and `toggleFileCollapse`**

Replace the full file with:

```typescript
import { useCallback, useMemo } from 'react'
import { useTaskViewState } from './use-task-view-state'
import type { DiffOptions } from '@/types'

/**
 * Persists diff viewer options per task in the backend.
 */
export function useDiffOptions(taskId: string) {
  const { viewState, setDiffOptions } = useTaskViewState(taskId)
  const { collapsedFiles } = viewState.diffOptions

  const collapsedSet = useMemo(() => new Set(collapsedFiles), [collapsedFiles])

  const toggleFileCollapse = useCallback(
    (path: string) => {
      const next = new Set(collapsedSet)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      setDiffOptions({ collapsedFiles: [...next] })
    },
    [collapsedSet, setDiffOptions]
  )

  const collapseAll = useCallback(
    (filePaths: string[]) => {
      setDiffOptions({ collapsedFiles: filePaths })
    },
    [setDiffOptions]
  )

  const expandAll = useCallback(() => {
    setDiffOptions({ collapsedFiles: [] })
  }, [setDiffOptions])

  const isFileCollapsed = useCallback(
    (path: string) => collapsedSet.has(path),
    [collapsedSet]
  )

  return {
    options: viewState.diffOptions,
    setOption: <K extends keyof DiffOptions>(key: K, value: DiffOptions[K]) => {
      setDiffOptions({ [key]: value })
    },
    setOptions: setDiffOptions,
    toggleFileCollapse,
    collapseAll,
    expandAll,
    isFileCollapsed,
  }
}
```

The diff from original:
- Added `collapsedSet = useMemo(() => new Set(collapsedFiles), [collapsedFiles])`
- `toggleFileCollapse` uses `Set.has/delete/add` instead of `Array.includes/filter/spread`
- `isFileCollapsed` uses `Set.has()` — O(1) instead of O(n)

**Step 2: Run build**

Run: `mise run build`
Expected: Success

**Step 3: Commit**

```bash
git add frontend/hooks/use-diff-options.ts
git commit -m "perf: use Set for collapsed file lookups in useDiffOptions"
```

---

### Task 5: Run tests and verify nothing is broken

**Files:**
- Test: `server/routes/git.test.ts`

**Step 1: Run all tests**

Run: `mise run test`
Expected: All tests pass. The git route tests exercise the API handlers; our async change to `/diff` should be transparent.

**Step 2: Run the specific git test file**

Run: `mise run test:file server/routes/git.test.ts`
Expected: All git tests pass.

**Step 3: If tests fail, fix and re-run**

If any test relies on the `/diff` handler being synchronous (unlikely, since Hono handlers are already awaited), adjust accordingly.

**Step 4: Final build check**

Run: `mise run build`
Expected: Clean build, no errors.

---

## Summary of Changes

| File | Change | Impact |
|------|--------|--------|
| `server/routes/git.ts` | Add `gitExecAsync`, convert `/diff` handler | Unblocks event loop during diff polling |
| `frontend/hooks/use-filesystem.ts` | Add `refetchIntervalInBackground: false` | Stops polling when tab hidden |
| `frontend/components/viewer/diff-viewer.tsx` | Virtualize with `@tanstack/react-virtual`, pre-compute classes | 10K lines → ~80 DOM nodes |
| `frontend/hooks/use-diff-options.ts` | `Set` for collapsed files | O(1) lookup instead of O(n) |

Expected net result: A 5000-line diff that previously froze the browser for seconds now renders in <16ms and scrolls at 60fps.
