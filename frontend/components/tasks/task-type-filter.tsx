import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { HugeiconsIcon } from '@hugeicons/react'
import { Cancel01Icon, ArrowDown01Icon, LayersIcon } from '@hugeicons/core-free-icons'
import { useTasks } from '@/hooks/use-tasks'
import { cn } from '@/lib/utils'
import { getTaskType, type TaskType } from '../../../shared/types'

const TASK_TYPES: TaskType[] = ['worktree', 'scratch', 'manual']

interface TaskTypeFilterProps {
  value: TaskType[]
  onChange: (types: TaskType[]) => void
}

export function TaskTypeFilter({ value, onChange }: TaskTypeFilterProps) {
  const { t } = useTranslation('tasks')
  const [open, setOpen] = useState(false)

  const { data: tasks = [] } = useTasks()

  // Count tasks per type
  const typeCounts: Record<TaskType, number> = { worktree: 0, scratch: 0, manual: 0 }
  for (const task of tasks) {
    typeCounts[getTaskType(task)]++
  }

  const toggleType = (type: TaskType) => {
    if (value.includes(type)) {
      onChange(value.filter((t) => t !== type))
    } else {
      onChange([...value, type])
    }
  }

  const removeType = (type: TaskType, e: React.MouseEvent) => {
    e.stopPropagation()
    onChange(value.filter((t) => t !== type))
  }

  const clearAll = (e: React.MouseEvent) => {
    e.stopPropagation()
    onChange([])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'shrink-0 gap-1.5 h-7 px-2',
              value.length > 0 && 'pr-1'
            )}
          />
        }
      >
        <HugeiconsIcon icon={LayersIcon} size={12} strokeWidth={2} className="text-muted-foreground" />
        {value.length === 0 ? (
          <>
            <span className="text-xs">{t('typeFilter.label')}</span>
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2} className="text-muted-foreground" />
          </>
        ) : (
          <>
            <div className="flex items-center gap-1">
              {value.map((type) => (
                <Badge
                  key={type}
                  variant="secondary"
                  className="h-5 px-1.5 text-[10px] gap-0.5"
                >
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: `var(--type-${type})` }}
                  />
                  {t(`typeFilter.types.${type}`)}
                  <button
                    onClick={(e) => removeType(type, e)}
                    className="hover:text-destructive transition-colors"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} size={10} />
                  </button>
                </Badge>
              ))}
            </div>
            <button
              onClick={clearAll}
              className="ml-0.5 p-0.5 hover:text-destructive transition-colors"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} />
            </button>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-0">
        <div className="py-1">
          {TASK_TYPES.map((type) => {
            const isSelected = value.includes(type)
            return (
              <button
                key={type}
                className={cn(
                  'w-full px-3 py-1.5 text-left text-xs hover:bg-accent flex items-center gap-2',
                  isSelected && 'bg-accent/50'
                )}
                onClick={() => toggleType(type)}
              >
                <Checkbox
                  checked={isSelected}
                  className="pointer-events-none"
                />
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: `var(--type-${type})` }}
                />
                <span className="flex-1">{t(`typeFilter.types.${type}`)}</span>
                <span className="text-muted-foreground text-[10px]">
                  {typeCounts[type]}
                </span>
              </button>
            )
          })}
        </div>
        {value.length > 0 && (
          <div className="p-2 border-t">
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-7 text-xs"
              onClick={() => {
                onChange([])
                setOpen(false)
              }}
            >
              {t('typeFilter.clear')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
