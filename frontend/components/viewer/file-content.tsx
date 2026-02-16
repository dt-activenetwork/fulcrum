import { useCallback, useRef, useEffect, useContext } from 'react'
import { observer } from 'mobx-react-lite'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  Cancel01Icon,
  TextIcon,
  SourceCodeIcon,
  Search01Icon,
} from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'
import { useFilesStoreActions } from '@/stores'
import { useFileChangePolling } from '@/hooks/use-file-change-polling'
import { MonacoEditor, type EditorActions } from './monaco-editor'
import { MarkdownRenderer } from './markdown-renderer'
import { FileChangeDialog } from './file-change-dialog'
import { CallbacksContext } from './files-viewer'

const AUTO_SAVE_DELAY = 1000 // 1 second debounce

interface FileContentProps {
  onBack?: () => void
}

export const FileContent = observer(function FileContent({ onBack }: FileContentProps) {
  const { onFileSaved } = useContext(CallbacksContext)
  const {
    worktreePath,
    readOnly,
    selectedFile,
    currentFile,
    isLoading,
    isSaving,
    loadError,
    isDirty,
    updateContent,
    saveFile,
    reloadFile,
    closeFile,
    toggleMarkdownView,
  } = useFilesStoreActions()

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorActionsRef = useRef<EditorActions | null>(null)

  // Poll for external file changes
  // Disable polling while dirty - we don't need to detect external changes while editing
  // and this prevents detecting our own saves as external changes
  const { hasExternalChange, isConflict, resetExternalChange } =
    useFileChangePolling({
      worktreePath,
      filePath: selectedFile,
      currentMtime: currentFile?.mtime ?? null,
      isDirty,
      enabled: !!currentFile && !isLoading && currentFile.isEditable && !isDirty,
    })

  // Handle silent reload when file changed externally and no local edits
  useEffect(() => {
    if (hasExternalChange && !isDirty && selectedFile) {
      reloadFile(selectedFile).then(() => {
        resetExternalChange()
      })
    }
  }, [hasExternalChange, isDirty, selectedFile, reloadFile, resetExternalChange])

  const handleKeepChanges = useCallback(() => {
    // User chose to keep their changes - reset the external change flag
    // The next poll will detect the mtime difference again, but we track
    // that we've already notified them in the hook
    resetExternalChange()
  }, [resetExternalChange])

  const handleReloadFile = useCallback(() => {
    if (selectedFile) {
      // Cancel any pending save since we're discarding changes
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      reloadFile(selectedFile).then(() => {
        resetExternalChange()
      })
    }
  }, [selectedFile, reloadFile, resetExternalChange])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }
    }
  }, [])

  const handleContentChange = useCallback(
    (newValue: string) => {
      if (!selectedFile || readOnly) return

      updateContent(selectedFile, newValue)

      // Clear existing timer
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
      }

      // Set new debounced save
      saveTimerRef.current = setTimeout(() => {
        saveFile(selectedFile)
          .then(() => {
            onFileSaved?.(selectedFile)
          })
          .catch((err) => {
            console.error('Auto-save failed:', err)
          })
      }, AUTO_SAVE_DELAY)
    },
    [selectedFile, readOnly, updateContent, saveFile, onFileSaved]
  )

  const handleBack = useCallback(() => {
    if (selectedFile) {
      // Cancel pending save
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      closeFile(selectedFile)
    }
    onBack?.()
  }, [selectedFile, closeFile, onBack])

  const handleToggleMarkdownView = useCallback(() => {
    if (selectedFile) {
      toggleMarkdownView(selectedFile)
    }
  }, [selectedFile, toggleMarkdownView])

  // No file selected
  if (!selectedFile) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Select a file to view
      </div>
    )
  }

  // Loading
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Loading file...
      </div>
    )
  }

  // Error
  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center text-destructive text-sm">
        {loadError}
      </div>
    )
  }

  // No content
  if (!currentFile) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Unable to load file
      </div>
    )
  }

  // PDF file
  if (currentFile.isPdf) {
    const pdfUrl = `/api/fs/raw?path=${encodeURIComponent(selectedFile)}&root=${encodeURIComponent(worktreePath || '')}`
    return (
      <div className="flex flex-col h-full overflow-hidden bg-background">
        <div className="flex shrink-0 items-center justify-between px-2 py-1.5 bg-card border-b border-border text-xs">
          <span className="text-muted-foreground truncate" title={selectedFile}>
            {selectedFile.split('/').pop() || selectedFile}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              {(currentFile.size / 1024).toFixed(1)} KB
            </span>
            <button
              onClick={handleBack}
              className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted/50"
              title="Close file"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <iframe
            src={pdfUrl}
            className="w-full h-full border-0"
            title={selectedFile}
          />
        </div>
      </div>
    )
  }

  // Binary file
  if (currentFile.isBinary) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-background">
        <div className="flex shrink-0 items-center justify-between px-2 py-1.5 bg-card border-b border-border text-xs">
          <span className="text-muted-foreground truncate" title={selectedFile}>
            {selectedFile.split('/').pop() || selectedFile}
          </span>
          <button
            onClick={handleBack}
            className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted/50"
            title="Close file"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center text-muted-foreground text-sm gap-2">
          <p>Binary file</p>
          <p className="text-xs">{(currentFile.size / 1024).toFixed(1)} KB</p>
        </div>
      </div>
    )
  }

  // Image file
  if (currentFile.isImage) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-background">
        <div className="flex shrink-0 items-center justify-between px-2 py-1.5 bg-card border-b border-border text-xs">
          <span className="text-muted-foreground truncate" title={selectedFile}>
            {selectedFile.split('/').pop() || selectedFile}
          </span>
          <button
            onClick={handleBack}
            className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted/50"
            title="Close file"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 bg-muted">
          <img
            src={currentFile.content}
            alt={selectedFile}
            className="block mx-auto"
          />
        </div>
      </div>
    )
  }

  // Text/code file
  const fileName = selectedFile.split('/').pop() || selectedFile
  const isMarkdownFile = currentFile.isMarkdown
  const showMarkdownPreview = isMarkdownFile && currentFile.isMarkdownView

  return (
    <>
      {/* File change conflict dialog */}
      <FileChangeDialog
        open={isConflict}
        fileName={fileName}
        onKeepChanges={handleKeepChanges}
        onReload={handleReloadFile}
      />

      <div className="flex flex-col h-full overflow-hidden bg-background">
        {/* Toolbar */}
        <div className="flex shrink-0 items-center gap-3 px-2 py-1.5 bg-card border-b border-border text-xs">
          <span
            className="text-muted-foreground truncate flex-1 flex items-center gap-1"
            title={selectedFile}
          >
            {fileName}
            {!readOnly && isDirty && <span className="text-amber-500">*</span>}
            {!readOnly && isSaving && (
              <span className="text-muted-foreground italic">(saving...)</span>
            )}
          </span>

          {currentFile.truncated && (
            <span className="text-destructive">
              Truncated ({currentFile.lineCount.toLocaleString()} lines)
            </span>
          )}

          <span className="text-muted-foreground">
            {(currentFile.size / 1024).toFixed(1)} KB
          </span>

          {/* Markdown toggle - only show for .md files */}
          {isMarkdownFile && (
            <button
              onClick={handleToggleMarkdownView}
              className={cn(
                'p-1 rounded hover:bg-muted/50 transition-colors',
                showMarkdownPreview
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              title={showMarkdownPreview ? 'Show code' : 'Preview markdown'}
            >
              <HugeiconsIcon
                icon={showMarkdownPreview ? SourceCodeIcon : TextIcon}
                size={14}
                strokeWidth={2}
              />
            </button>
          )}

          {/* Search - only show when not in markdown preview */}
          {!showMarkdownPreview && (
            <button
              onClick={() => editorActionsRef.current?.triggerFind()}
              className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted/50"
              title="Find (Ctrl+F)"
            >
              <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={2} />
            </button>
          )}

          <button
            onClick={handleBack}
            className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted/50"
            title="Close file"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 min-h-0">
          {showMarkdownPreview ? (
            <MarkdownRenderer
              content={currentFile.content}
              worktreePath={worktreePath || ''}
              filePath={selectedFile}
            />
          ) : (
            <MonacoEditor
              filePath={selectedFile}
              content={currentFile.content}
              onChange={handleContentChange}
              readOnly={readOnly || !currentFile.isEditable}
              onEditorReady={(actions) => {
                editorActionsRef.current = actions
              }}
            />
          )}
        </div>
      </div>
    </>
  )
})
