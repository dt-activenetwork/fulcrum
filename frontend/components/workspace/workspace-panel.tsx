import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { Button } from '@/components/ui/button'
import { HugeiconsIcon } from '@hugeicons/react'
import { Loading03Icon } from '@hugeicons/core-free-icons'
import { FilesViewer } from '@/components/viewer/files-viewer'
import { Terminal } from '@/components/terminal/terminal'
import { useTerminalWS } from '@/hooks/use-terminal-ws'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { log } from '@/lib/logger'
import type { Terminal as XTerm } from '@xterm/xterm'

export interface WorkspacePanelProps {
  /** The directory path to use for terminal cwd and file viewer */
  repoPath: string
  /** Display name for terminal tab */
  repoDisplayName: string
  /** Current parent tab value (to know when workspace is active) */
  activeTab: string
  /** Currently selected file (from URL) */
  file?: string
  /** Callback when file selection changes */
  onFileChange: (file: string | null) => void
  /** Callback when a file is saved */
  onFileSaved?: (file: string) => void
}

/**
 * Reusable workspace panel with terminal and file viewer.
 * Used in both repository detail view and app detail view.
 */
export function WorkspacePanel({
  repoPath,
  repoDisplayName,
  activeTab,
  file,
  onFileChange,
  onFileSaved,
}: WorkspacePanelProps) {
  const { t } = useTranslation('repositories')
  const isMobile = useIsMobile()

  // Mobile sub-tab state
  const [mobileWorkspaceTab, setMobileWorkspaceTab] = useState<'terminal' | 'files'>('terminal')

  // Terminal state
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [isCreatingTerminal, setIsCreatingTerminal] = useState(false)
  const [xtermReady, setXtermReady] = useState(false)
  const [containerReady, setContainerReady] = useState(false)
  const termRef = useRef<XTerm | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const createdTerminalRef = useRef(false)
  const attachedRef = useRef(false)

  const {
    terminals,
    terminalsLoaded,
    connected,
    createTerminal,
    recreateTerminal,
    attachXterm,
    resizeTerminal,
    setupImagePaste,
    writeToTerminal,
  } = useTerminalWS()

  // Get the current terminal's status
  const currentTerminal = terminalId ? terminals.find((t) => t.id === terminalId) : null
  const terminalStatus = currentTerminal?.status

  // Log on mount
  useEffect(() => {
    log.repoTerminal.info('WorkspacePanel mounted', { repoPath, activeTab })
  }, [repoPath, activeTab])

  useEffect(() => {
    log.repoTerminal.debug('WorkspacePanel state changed', {
      terminalId,
      xtermReady,
      containerReady,
      connected,
      terminalsLoaded,
      terminalCount: terminals.length,
      repoPath,
    })
  }, [terminalId, xtermReady, containerReady, connected, terminalsLoaded, terminals.length, repoPath])

  // Reset terminal state when repository path changes
  // Note: Don't reset xtermReady - the Terminal component stays mounted and reuses the same xterm instance
  useEffect(() => {
    createdTerminalRef.current = false
    attachedRef.current = false
    setTerminalId(null)
    setIsCreatingTerminal(false)
  }, [repoPath])

  // Find or create terminal when workspace tab is active
  useEffect(() => {
    if (!connected || !repoPath || !terminalsLoaded || activeTab !== 'workspace') {
      log.repoTerminal.debug('find/create: waiting', { connected, repoPath, terminalsLoaded, activeTab })
      return
    }

    // Look for existing running terminal with matching cwd
    const existingTerminal = terminals.find((t) => t.cwd === repoPath && t.status === 'running')
    if (existingTerminal) {
      log.repoTerminal.info('found existing terminal', { id: existingTerminal.id, cwd: existingTerminal.cwd })
      setTerminalId(existingTerminal.id)
      return
    }

    // Create terminal only once
    if (!createdTerminalRef.current) {
      createdTerminalRef.current = true
      setIsCreatingTerminal(true)
      log.repoTerminal.info('creating terminal', { name: repoDisplayName, cwd: repoPath, cols: 80, rows: 24 })
      createTerminal({
        name: repoDisplayName,
        cols: 80,
        rows: 24,
        cwd: repoPath,
      })
    }
  }, [connected, repoPath, repoDisplayName, terminalsLoaded, terminals, activeTab, createTerminal])

  // Update terminalId when terminal appears in list
  useEffect(() => {
    if (!repoPath) return

    const matchingTerminal = terminals.find((t) => t.cwd === repoPath && t.status === 'running')
    if (!matchingTerminal) return

    const currentTerminalExists = terminalId && terminals.some((t) => t.id === terminalId)

    if (!terminalId || !currentTerminalExists) {
      setTerminalId(matchingTerminal.id)
      setIsCreatingTerminal(false)
      if (terminalId && !currentTerminalExists) {
        attachedRef.current = false
      }
    }
  }, [terminals, repoPath, terminalId])

  // Terminal callbacks
  const handleTerminalReady = useCallback((xterm: XTerm) => {
    log.repoTerminal.info('xterm ready')
    termRef.current = xterm
    setXtermReady(true)
  }, [])

  const handleTerminalResize = useCallback((cols: number, rows: number) => {
    if (terminalId) {
      resizeTerminal(terminalId, cols, rows)
    }
  }, [terminalId, resizeTerminal])

  const handleTerminalContainerReady = useCallback((container: HTMLDivElement) => {
    log.repoTerminal.info('container ready')
    containerRef.current = container
    setContainerReady(true)
  }, [])

  const handleTerminalSend = useCallback((data: string) => {
    if (terminalId) {
      writeToTerminal(terminalId, data)
    }
  }, [terminalId, writeToTerminal])

  // Handle terminal recreation (for stale/dead dtach sockets)
  const handleRecreate = useCallback(() => {
    if (terminalId) {
      // Reset refs so we can re-attach after recreation
      attachedRef.current = false
      createdTerminalRef.current = false
      setTerminalId(null)
      recreateTerminal(terminalId)
    }
  }, [terminalId, recreateTerminal])

  // Attach xterm to terminal once we have terminalId and both xterm/container are ready
  useEffect(() => {
    if (!terminalId || !xtermReady || !containerReady) {
      log.repoTerminal.debug('attach effect: waiting', { terminalId, xtermReady, containerReady })
      return
    }
    if (!termRef.current || !containerRef.current) {
      log.repoTerminal.warn('attach effect: refs not set despite ready states', { terminalId })
      return
    }
    if (attachedRef.current) {
      log.repoTerminal.debug('attach effect: already attached', { terminalId })
      return
    }

    log.repoTerminal.info('attaching terminal', { terminalId })
    attachXterm(terminalId, termRef.current)
    setupImagePaste(containerRef.current, terminalId)
    attachedRef.current = true

    return () => {
      log.repoTerminal.debug('detaching terminal', { terminalId })
      attachedRef.current = false
    }
  }, [terminalId, xtermReady, containerReady, attachXterm, setupImagePaste])

  // Render loading overlay for terminal creation
  const renderTerminalLoadingOverlay = () => {
    if (!isCreatingTerminal || terminalId) return null
    return (
      <div className="flex-1 flex items-center justify-center bg-terminal-background">
        <div className="flex flex-col items-center gap-3">
          <HugeiconsIcon
            icon={Loading03Icon}
            size={24}
            strokeWidth={2}
            className="animate-spin text-muted-foreground"
          />
          <span className="font-mono text-sm text-muted-foreground">
            {t('detailView.workspace.initializingTerminal')}
          </span>
        </div>
      </div>
    )
  }

  // Render connection status bar
  const renderConnectionStatus = () => {
    if (connected) return null
    return (
      <div className="shrink-0 px-2 py-1 bg-muted-foreground/20 text-muted-foreground text-xs">
        {t('detailView.workspace.connectingToTerminal')}
      </div>
    )
  }

  // Render error overlay with recreate button (for stale dtach sockets)
  const renderErrorOverlay = () => {
    if (!terminalId || !terminalStatus || terminalStatus === 'running') return null
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-terminal-background/95">
        <div className="flex flex-col items-center gap-4">
          <span className="text-sm text-destructive">
            {t('detailView.workspace.terminalConnectionFailed')}
          </span>
          <Button onClick={handleRecreate} variant="outline">
            {t('detailView.workspace.recreateTerminal')}
          </Button>
        </div>
      </div>
    )
  }

  if (isMobile) {
    return (
      <Tabs
        value={mobileWorkspaceTab}
        onValueChange={(v) => setMobileWorkspaceTab(v as 'terminal' | 'files')}
        className="flex min-h-0 flex-1 flex-col h-full"
      >
        <div className="shrink-0 border-b border-border px-2 py-1">
          <TabsList className="w-full">
            <TabsTrigger value="terminal" className="flex-1">{t('detailView.mobileWorkspace.terminal')}</TabsTrigger>
            <TabsTrigger value="files" className="flex-1">{t('detailView.mobileWorkspace.files')}</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="terminal" className="flex-1 min-h-0">
          <div className="relative h-full flex flex-col">
            {renderConnectionStatus()}
            {renderTerminalLoadingOverlay()}
            {renderErrorOverlay()}
            <Terminal
              className="flex-1"
              onReady={handleTerminalReady}
              onResize={handleTerminalResize}
              onContainerReady={handleTerminalContainerReady}
              terminalId={terminalId ?? undefined}
              setupImagePaste={setupImagePaste}
              onSend={handleTerminalSend}
            />
          </div>
        </TabsContent>

        <TabsContent value="files" className="flex-1 min-h-0">
          <FilesViewer
            worktreePath={repoPath}
            initialSelectedFile={file}
            onFileChange={onFileChange}
            onFileSaved={onFileSaved}
          />
        </TabsContent>
      </Tabs>
    )
  }

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full">
      <ResizablePanel defaultSize={50} minSize={30}>
        <div className="relative h-full flex flex-col">
          {renderConnectionStatus()}
          {renderTerminalLoadingOverlay()}
          {renderErrorOverlay()}
          <Terminal
            className="flex-1"
            onReady={handleTerminalReady}
            onResize={handleTerminalResize}
            onContainerReady={handleTerminalContainerReady}
            terminalId={terminalId ?? undefined}
            setupImagePaste={setupImagePaste}
            onSend={handleTerminalSend}
          />
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={50} minSize={30}>
        <FilesViewer
          worktreePath={repoPath}
          initialSelectedFile={file}
          onFileChange={onFileChange}
          onFileSaved={onFileSaved}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
