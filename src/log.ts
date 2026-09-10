import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type OpenAI from "openai"

export type Outcome = "ok" | "tool_error" | "invalid_call"

export type ToolCallLog = {
    name: string
    rawArguments: string
    outcome: Outcome
    result: string
}

export type RoundLog = {
    index: number
    content: string | null
    usage: OpenAI.Completions.CompletionUsage | null
    toolCalls: ToolCallLog[]
}

export type RunLog = {
    startedAt: string
    model: string
    issue: string
    systemPrompt: string
    rounds: RoundLog[]
    answer: string | null
    endedAs: "answered" | "out_of_turns" | "threw"
}

const runsDir = fileURLToPath(new URL("../runs/", import.meta.url))

export const writeRunLog = async (log: RunLog): Promise<string> => {
    await mkdir(runsDir, { recursive: true })
    const path = join(runsDir, `${log.startedAt.replace(/[:.]/g, "-")}.json`)
    await writeFile(path, JSON.stringify(log, null, 2), "utf-8")
    return path
}
