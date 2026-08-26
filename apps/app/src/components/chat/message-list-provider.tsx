"use memo";

import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store"
import type {
  ChatToolReconnectAction,
  ChatToolReconnectProgress,
  ChatToolReconnectResult,
} from "@/components/tools/error-attribution"
import * as React from "react"

interface MessageListContextValue {
  workspaceId: string
  sessionId: string
  showThinking: boolean
  highlightQuery?: string
  developerMode: boolean
  displaySuggestions: boolean
  providerConnectedCount: number
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void
  onEditUserMessage: (messageId: string, text: string) => void
  /** Open a sub-agent (child) session in the main chat surface. */
  onOpenSubagentSession?: (sessionId: string) => void
  onMcpReconnect: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ) => Promise<ChatToolReconnectResult>
  onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string) => Promise<void>
  onMcpRetry: (action: ChatToolReconnectAction) => void | Promise<void>
}

const MessageListContext = React.createContext<MessageListContextValue | null>(null)

interface MessageListProviderProps {
  children: React.ReactNode
  workspaceId: string
  sessionId: string
  showThinking: boolean
  highlightQuery?: string
  developerMode: boolean
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void
  onEditUserMessage: (messageId: string, text: string) => void
  onOpenSubagentSession?: (sessionId: string) => void
  onMcpReconnect: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ) => Promise<ChatToolReconnectResult>
  onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string) => Promise<void>
  onMcpRetry: (action: ChatToolReconnectAction) => void | Promise<void>
  displaySuggestions: boolean
  providerConnectedCount: number
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
}

export interface DispatchAction {
  target: "settings"
  action: "open"
  section: "commands" | "skills" | "mcps" | "plugins" | "providers"
}

export function MessageListProvider({
  children,
  workspaceId,
  sessionId,
  showThinking,
  highlightQuery,
  developerMode,
  displaySuggestions,
  providerConnectedCount,
  dispatchAction,
  setPrompt,
  onRevertToUserMessage,
  onForkAtMessage,
  onEditUserMessage,
  onOpenSubagentSession,
  onMcpReconnect,
  onMcpReopenAuthorization,
  onMcpRetry,
}: MessageListProviderProps) {
  const handlersRef = React.useRef({
    dispatchAction,
    setPrompt,
    onRevertToUserMessage,
    onForkAtMessage,
    onEditUserMessage,
    onOpenSubagentSession,
    onMcpReconnect,
    onMcpReopenAuthorization,
    onMcpRetry,
  })
  React.useEffect(() => {
    handlersRef.current = {
      dispatchAction,
      setPrompt,
      onRevertToUserMessage,
      onForkAtMessage,
      onEditUserMessage,
      onOpenSubagentSession,
      onMcpReconnect,
      onMcpReopenAuthorization,
      onMcpRetry,
    }
  }, [
    dispatchAction,
    setPrompt,
    onRevertToUserMessage,
    onForkAtMessage,
    onEditUserMessage,
    onOpenSubagentSession,
    onMcpReconnect,
    onMcpReopenAuthorization,
    onMcpRetry,
  ])
  const stableHandlers = React.useMemo(() => ({
    dispatchAction: (action: DispatchAction) => handlersRef.current.dispatchAction(action),
    setPrompt: (prompt: string) => handlersRef.current.setPrompt(prompt),
    onRevertToUserMessage: (messageId: string) => handlersRef.current.onRevertToUserMessage(messageId),
    onForkAtMessage: (messageId: string) => handlersRef.current.onForkAtMessage(messageId),
    onEditUserMessage: (messageId: string, text: string) => handlersRef.current.onEditUserMessage(messageId, text),
    onOpenSubagentSession: (sessionId: string) => handlersRef.current.onOpenSubagentSession?.(sessionId),
    onMcpReconnect: (
      action: ChatToolReconnectAction,
      onProgress: (progress: ChatToolReconnectProgress) => void,
    ) => handlersRef.current.onMcpReconnect(action, onProgress),
    onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string) => (
      handlersRef.current.onMcpReopenAuthorization(action, authorizeUrl)
    ),
    onMcpRetry: (action: ChatToolReconnectAction) => handlersRef.current.onMcpRetry(action),
  }), [])
  const canOpenSubagentSession = Boolean(onOpenSubagentSession)
  const value = React.useMemo(
    () => ({
      workspaceId,
      sessionId,
      showThinking,
      highlightQuery,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      ...stableHandlers,
      onOpenSubagentSession: canOpenSubagentSession
        ? stableHandlers.onOpenSubagentSession
        : undefined,
    }),
    [
      workspaceId,
      sessionId,
      showThinking,
      highlightQuery,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      stableHandlers,
      canOpenSubagentSession,
    ],
  )

  return (
    <MessageListContext.Provider value={value}>
      {children}
    </MessageListContext.Provider>
  )
}

export function useMessageList() {
  const context = React.useContext(MessageListContext)

  if (!context) {
    throw new Error("useMessageList must be used within a MessageListProvider")
  }

  return context
}

export function useSessionErrorMessage() {
  const { workspaceId, sessionId } = useMessageList();

  return useSessionActivityStore(state => state.getSessionError(workspaceId, sessionId));
}
