"use client"

import { Fragment, useState } from "react"
import { AlertTriangle, CircleHelp, CirclePause, MoreHorizontal } from "lucide-react"

import { FileChip } from "@/components/chat/file-chip"
import { ShellCommandText } from "@/components/chat/shell-command-text"
import { ReasoningBlock } from "@/components/chat/reasoning-block"
import { useCurrentToolLifecycleResolver } from "@/components/chat/current-tool-lifecycle-context"
import {
  getAggregateNowLabel,
  getAggregateCountSummary,
  getToolAggregateLifecycle,
  getAggregateRowFile,
  getAggregateRowLabel,
  getAggregateSummary,
  getToolFamily,
  type AggregateThought,
  type AnyToolPart,
} from "@/lib/tool-aggregate"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { isBashToolPart } from "@/lib/build-in-tools"
import { trackToolCallDuration } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"

const ROW_CAP = 8

/** Expansion persists per group while the session stays mounted (Paper rule). */
const expandedByGroupKey = new Map<string, boolean>()
const showAllByGroupKey = new Map<string, boolean>()

type ToolAggregateGroupProps = {
  parts: AnyToolPart[]
  /** Thoughts that happened inside the run, anchored by afterIndex. */
  thoughts?: AggregateThought[]
  className?: string
}

function persistedRowStatus(part: AnyToolPart): "running" | "failed" | "done" {
  if (isToolPartInFlight(part)) return "running"
  if (part.state === "output-error") return "failed"
  return "done"
}

function failureReason(part: AnyToolPart): string | null {
  if (part.state !== "output-error" || !part.errorText) return null
  const firstLine = part.errorText.split("\n")[0]?.trim()
  return firstLine ? (firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine) : null
}

type AggregateRow = {
  /** The most recent call in the row (drives status, label, key). */
  part: AnyToolPart
  /** Original index of the row's first call — anchors interleaved thoughts. */
  index: number
  /** Original index of the row's latest call — picks its frozen duration. */
  lastIndex: number
  /** How many identical calls this row represents. */
  repeat: number
}

/**
 * The header summary counts unique files ("Read 1 file"), so repeated
 * settled reads of the same file collapse into one row with a ×N badge
 * instead of rendering as confusing duplicates. A thought anchored
 * between two reads keeps them apart to preserve chronology.
 */
export function buildAggregateRows(parts: AnyToolPart[], thoughts: AggregateThought[]): AggregateRow[] {
  const hasThoughtAt = (index: number) => thoughts.some((thought) => thought.afterIndex === index)
  const rows: AggregateRow[] = []
  parts.forEach((part, index) => {
    const previous = rows.at(-1)
    const file = getAggregateRowFile(part)
    const previousFile = previous ? getAggregateRowFile(previous.part) : null
    const mergeable =
      previous !== undefined &&
      file !== null &&
      previousFile !== null &&
      getToolFamily(part) === "read" &&
      getToolFamily(previous.part) === "read" &&
      file.path === previousFile.path &&
      persistedRowStatus(part) === "done" &&
      persistedRowStatus(previous.part) === "done" &&
      !hasThoughtAt(index)
    if (mergeable) {
      previous.part = part
      previous.lastIndex = index
      previous.repeat += 1
      return
    }
    rows.push({ part, index, lastIndex: index, repeat: 1 })
  })
  return rows
}

/**
 * Paper "Recurring actions · aggregate + latest": one line with live
 * totals while running plus a self-replacing shimmer line naming the
 * current action; past-tense summary when done. Chevron expands the chronological list — status
 * dot, monospace action, per-item duration — capped with "Show N more".
 */
export function ToolAggregateGroup({ parts, thoughts = [], className }: ToolAggregateGroupProps) {
  const groupKey = parts[0]?.toolCallId ?? "aggregate"
  const latestToolCallId = parts.at(-1)?.toolCallId ?? groupKey
  const [expanded, setExpandedState] = useState(() => expandedByGroupKey.get(groupKey) ?? false)
  const [showAll, setShowAllState] = useState(() => showAllByGroupKey.get(groupKey) ?? false)
  const resolveLifecycle = useCurrentToolLifecycleResolver()

  const setExpanded = (value: boolean) => {
    expandedByGroupKey.set(groupKey, value)
    setExpandedState(value)
  }
  const setShowAll = (value: boolean) => {
    showAllByGroupKey.set(groupKey, value)
    setShowAllState(value)
  }

  const inFlightPart = parts.find((part) => isToolPartInFlight(part))
  const currentLifecycle = resolveLifecycle(
    inFlightPart?.toolCallId ?? "",
    Boolean(inFlightPart),
  )
  const aggregateLifecycle = getToolAggregateLifecycle(parts, currentLifecycle)
  const visiblyRunning = aggregateLifecycle === "running"
  const failedCount = parts.filter((part) => part.state === "output-error").length
  const countSummary = getAggregateCountSummary(parts)
  const summary = aggregateLifecycle === "waiting"
    ? `Waiting for your action · ${countSummary}`
    : aggregateLifecycle === "unknown"
      ? `Status unknown · ${countSummary}`
      : getAggregateSummary(parts, visiblyRunning ? "present" : "past")
  const nowLabel = visiblyRunning ? getAggregateNowLabel(parts) : null
  // The model is thinking mid-run: no tool is in flight but the run's
  // latest thought is still streaming. Show that instead of dead air.
  const lastThought = thoughts.at(-1)
  const thinkingNow = !nowLabel && Boolean(lastThought?.isStreaming)

  // Track durations for every part so each is frozen the moment it completes.
  const durations = parts.map((part) => trackToolCallDuration(part))
  const singleCommand = parts.length === 1 && Boolean(parts[0] && isBashToolPart(parts[0]))
  const singleCommandDuration = singleCommand ? durations[0] : null
  const rows = buildAggregateRows(parts, thoughts)
  const visibleRows = showAll ? rows : rows.slice(0, ROW_CAP)
  const hiddenCount = rows.length - visibleRows.length
  // Expanded rows interleave the run's thoughts at their chronological
  // slots; thoughts belonging to capped rows stay behind "Show N more".
  const thoughtsAt = (index: number) => thoughts.filter((thought) => thought.afterIndex === index)
  const trailingThoughts = hiddenCount > 0 ? [] : thoughts.filter((thought) => thought.afterIndex >= parts.length)

  // "Edited 1 file" above "Edited file-chip.tsx" says nothing twice.
  // A group that is exactly one file action (and no thoughts) renders
  // as the row itself — verb, chip, duration — with nothing to expand.
  const soloRow = rows.length === 1 && thoughts.length === 0 ? rows[0] : undefined
  const soloFile = soloRow ? getAggregateRowFile(soloRow.part) : null
  if (soloRow && soloFile) {
    const status = currentLifecycle ?? persistedRowStatus(soloRow.part)
    const reason = failureReason(soloRow.part)
    return (
      <div
        className={className}
        data-tool-aggregate={latestToolCallId}
        data-tool-lifecycle={currentLifecycle ?? (visiblyRunning ? "running" : "settled")}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <span className={cn("shrink-0", status === "running" && "text-foreground ow-text-shimmer")}>
            {soloFile.verb}
          </span>
          <FileChip path={soloFile.path} className="min-w-0" />
          {soloRow.repeat > 1 ? (
            <span data-tool-aggregate-repeat className="shrink-0 text-xs text-muted-foreground/70">
              ×{soloRow.repeat}
            </span>
          ) : null}
          {durations[soloRow.lastIndex] ? (
            <span className="shrink-0 tabular-nums text-xs text-muted-foreground/70">
              {durations[soloRow.lastIndex]}
            </span>
          ) : null}
        </div>
        {status === "waiting" ? (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-11" role="status">
            <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
            <span>Choose an option or approve the request to continue.</span>
          </div>
        ) : null}
        {status === "interrupted" ? (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-destructive" role="alert">
            <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
            <span>This step stopped before it finished. Retry to continue.</span>
          </div>
        ) : null}
        {reason ? (
          <div className="mt-1 text-[11px] text-muted-foreground">failed — {reason}</div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={className}
      data-tool-aggregate={latestToolCallId}
      data-tool-lifecycle={aggregateLifecycle}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="group flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="min-w-0 truncate">{summary}</span>
        {thoughts.length > 0 ? (
          <span data-tool-aggregate-thought-count className="shrink-0 text-xs text-muted-foreground/70">
            · {thoughts.length === 1 ? "1 thought" : `${thoughts.length} thoughts`}
          </span>
        ) : null}
        {singleCommandDuration ? (
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground/70">
            {singleCommandDuration}
          </span>
        ) : null}
        {failedCount > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {failedCount} failed
          </span>
        ) : null}
      </button>

      {aggregateLifecycle === "waiting" ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-11" role="status">
          <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Choose an option or approve the request to continue.</span>
        </div>
      ) : null}

      {aggregateLifecycle === "unknown" ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <CircleHelp aria-hidden="true" className="size-3.5 shrink-0" />
          <span>No terminal result was observed. This step may still be running; check the session before retrying.</span>
        </div>
      ) : null}

      {nowLabel ? (
        <div data-tool-aggregate-now className="mt-1 min-w-0 text-sm text-muted-foreground">
          <span className="ow-text-shimmer block min-w-0 truncate">
            {nowLabel}
          </span>
        </div>
      ) : null}

      {thinkingNow ? (
        <div data-tool-aggregate-thinking className="mt-1 min-w-0 text-sm text-muted-foreground">
          <span className="ow-text-shimmer">Thinking…</span>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {visibleRows.map((row) => {
            const part = row.part
            const lifecycle = resolveLifecycle(part.toolCallId, isToolPartInFlight(part))
            const status = isToolPartInFlight(part)
              ? lifecycle === "running" || lifecycle === "waiting"
                ? lifecycle
                : "unknown"
              : persistedRowStatus(part)
            const reason = failureReason(part)
            const bash = isBashToolPart(part)
            const command = bash ? part.input?.command?.trim() ?? "" : ""
            const commandDescription = bash
              ? part.input?.description?.trim() || "command"
              : ""
            return (
              <Fragment key={part.toolCallId}>
              {thoughtsAt(row.index).map((thought) => (
                <div key={`thought-${row.index}-${thought.afterIndex}`} data-tool-aggregate-thought className="py-1">
                  <ReasoningBlock text={thought.text} isStreaming={thought.isStreaming} />
                </div>
              ))}
              <div className="flex min-w-0 flex-col gap-1.5 py-1">
                {!singleCommand ? (
                  <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  {status === "waiting" ? (
                    <CirclePause aria-label="Waiting" className="size-3.5 shrink-0 text-amber-11" />
                  ) : null}
                  {status === "unknown" ? (
                    <CircleHelp aria-label="Status unknown" className="size-3.5 shrink-0" />
                  ) : null}
                  {bash ? (
                    <span className="min-w-0 truncate">
                      <span className={cn("text-foreground", status === "running" && "ow-text-shimmer")}>
                        {status === "running"
                          ? "Running"
                          : status === "waiting"
                            ? "Waiting to run"
                            : status === "unknown"
                              ? "Status unknown for"
                              : "Ran"}
                      </span>{" "}
                      <span>{commandDescription}</span>
                    </span>
                  ) : (() => {
                    const file = getAggregateRowFile(part)
                    if (!file) {
                      return (
                        <span className={cn("min-w-0 truncate", status === "running" && "ow-text-shimmer")}>
                          {getAggregateRowLabel(part)}
                        </span>
                      )
                    }
                    return (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("shrink-0", status === "running" && "text-foreground ow-text-shimmer")}>
                          {file.verb}
                        </span>
                        <FileChip path={file.path} className="min-w-0" />
                        {row.repeat > 1 ? (
                          <span
                            data-tool-aggregate-repeat
                            className="shrink-0 text-xs text-muted-foreground/70"
                          >
                            ×{row.repeat}
                          </span>
                        ) : null}
                      </span>
                    )
                  })()}
                  {durations[row.lastIndex] ? (
                    <span className="shrink-0 tabular-nums text-muted-foreground/70">
                      {durations[row.lastIndex]}
                    </span>
                  ) : null}
                  </div>
                ) : null}
                {bash && command ? (
                  <div
                    data-tool-aggregate-command
                    className="flex min-w-0 items-center gap-2 rounded-xl border border-border/70 bg-gray-2/60 px-3 py-2 font-mono text-sm"
                  >
                    <span className="shrink-0 text-muted-foreground/60">$</span>
                    <ShellCommandText command={command} className="min-w-0 flex-1 truncate" />
                    <MoreHorizontal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
                  </div>
                ) : null}
                {reason ? (
                  <div className="text-[11px] text-muted-foreground">failed — {reason}</div>
                ) : null}
              </div>
              </Fragment>
            )
          })}
          {trailingThoughts.map((thought) => (
            <div key={`thought-trailing-${thought.afterIndex}`} data-tool-aggregate-thought className="py-1">
              <ReasoningBlock text={thought.text} isStreaming={thought.isStreaming} />
            </div>
          ))}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Show {hiddenCount} more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
