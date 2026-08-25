export interface PiSoundAction {
  eventTypes: string[]
  toolTrigger?: {
    type: "tool.before" | "tool.after"
    tool: string
  }
  messageRole: string | null
}

interface PiEvent {
  reason?: unknown
  toolName?: unknown
}

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  askuserquestion: "question",
  ask_user_question: "question",
  find: "glob",
  subagent: "task",
}

export function shouldEnablePiSession(mode: unknown): boolean {
  return mode === "tui" || mode === "rpc"
}

export function mapPiToolName(toolName: unknown): string | null {
  let normalizedName: string

  if (typeof toolName !== "string" || toolName.length === 0) {
    return null
  }

  normalizedName = toolName.toLowerCase()
  return TOOL_ALIASES[normalizedName] ?? normalizedName
}

export function translatePiEvent(eventName: string, event: PiEvent = {}): PiSoundAction | null {
  let toolName: string | null
  let eventTypes: string[]
  let triggerType: "tool.before" | "tool.after"

  switch (eventName) {
    case "session_start":
      if (event.reason === "reload") {
        return null
      }
      return { eventTypes: ["openpeon.startup"], messageRole: null }
    case "input":
      return { eventTypes: ["message.updated"], messageRole: "user" }
    case "agent_settled":
      return { eventTypes: ["session.idle"], messageRole: null }
    case "user_bash":
      return {
        eventTypes: ["command.executed", "tui.command.execute"],
        messageRole: null,
      }
    case "tool_execution_start":
    case "tool_execution_end":
      toolName = mapPiToolName(event.toolName)
      if (!toolName) {
        return null
      }

      triggerType = eventName === "tool_execution_start" ? "tool.before" : "tool.after"
      eventTypes = []
      if (toolName === "question") {
        eventTypes.push(eventName === "tool_execution_start" ? "permission.asked" : "permission.replied")
      }

      return {
        eventTypes,
        toolTrigger: { type: triggerType, tool: toolName },
        messageRole: null,
      }
    default:
      return null
  }
}
