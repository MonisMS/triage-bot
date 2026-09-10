import OpenAI from "openai"
import type { IssueRef } from "./github.js"
import { writeRunLog, type Outcome, type RoundLog, type RunLog } from "./log.js"
import { systemPrompt } from "./prompt.js"
import {
    INVALID_CALL,
    ListFileSchema,
    ReadFileSchema,
    RecentChangesSchema,
    SearchCodeSchema,
    TOOL_ERROR,
    listFiles,
    readFileTool,
    recentChanges,
    searchCode,
    tools,
    withArgs,
} from "./tools.js"

const readEnv = (envVar: string | undefined, varName: string): string => {
    if (!envVar) {
        throw new Error(`${varName} is missing. Set it in .env`)
    }
    return envVar
}

const client = new OpenAI({
    apiKey: readEnv(process.env.GOOGLE_API_KEY, "GOOGLE_API_KEY"),
    baseURL: process.env.BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
    timeout: 120_000,
    maxRetries: 0,
})

const MODEL = "gemini-3.8-flash"

const MAX_TURNS = 6
const WARN_AT = 2
const PACE_MS = 13_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const RETRY_STATUSES = new Set([500, 502, 503, 504])
const MAX_ATTEMPTS = 3
const BACKOFF_MS = 2_000

const createWithRetry = async (
    body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
): Promise<OpenAI.Chat.ChatCompletion> => {
    for (let attempt = 1; ; attempt++) {
        try {
            return await client.chat.completions.create(body)
        } catch (error) {
            const status = (error as { status?: number }).status
            if (status === undefined || !RETRY_STATUSES.has(status) || attempt >= MAX_ATTEMPTS) {
                throw error
            }
            const waitMs = BACKOFF_MS * attempt
            console.log(`  ${status} from the model, retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`)
            await sleep(waitMs)
        }
    }
}

export const runAgent = async (
    issueText: string,
    repoPath: string,
    ref: IssueRef,
): Promise<string | null> => {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: issueText },
    ]

    const runLog: RunLog = {
        startedAt: new Date().toISOString(),
        model: MODEL,
        repo: `${ref.owner}/${ref.repo}`,
        issueNumber: ref.number,
        issue: issueText,
        systemPrompt,
        rounds: [],
        answer: null,
        endedAs: "threw",
    }

    try {
        for (let i = 0; i < MAX_TURNS; i++) {
            const turnsLeft = MAX_TURNS - 1 - i
            const isLastTurn = turnsLeft === 0

            if (turnsLeft === WARN_AT) {
                messages.push({
                    role: "user",
                    content: `You have ${WARN_AT} tool calls left. Start narrowing down and be ready to answer.`,
                })
            }
            if (isLastTurn) {
                messages.push({
                    role: "user",
                    content: "No tool calls remain. Answer now with what you have found so far. " +
                        "If something is still unconfirmed, say so plainly rather than guessing.",
                })
            }

            if (i > 0) {
                await sleep(PACE_MS)
            }

            console.log(`[${i}] calling model...${isLastTurn ? " (final, no tools)" : ""}`)
            const response = await createWithRetry({
                model: MODEL,
                messages,
                ...(isLastTurn ? {} : { tools }),
            })
            const message = response.choices[0]?.message
            if (!message) {
                throw new Error("no message in response")
            }
            messages.push(message)

            const round: RoundLog = {
                index: i,
                content: message.content ?? null,
                usage: response.usage ?? null,
                toolCalls: [],
            }
            runLog.rounds.push(round)

            const calls = message.tool_calls ?? []
            if (calls.length === 0) {
                console.log(message.content)
                runLog.answer = message.content ?? null
                runLog.endedAs = "answered"
                return runLog.answer
            }

            for (const call of calls) {
                if (call.type !== "function") {
                    const unsupported = `${INVALID_CALL} unsupported tool call type: ${call.type}`
                    messages.push({ role: "tool", tool_call_id: call.id, content: unsupported })
                    round.toolCalls.push({
                        name: `(${call.type})`,
                        rawArguments: "",
                        outcome: "invalid_call",
                        result: unsupported,
                    })
                    continue
                }

                const name = call.function.name
                const raw = call.function.arguments

                const result =
                    name === "search_code" ? await withArgs(SearchCodeSchema, raw, (a) => searchCode(repoPath, a.query))
                    : name === "read_file" ? await withArgs(ReadFileSchema, raw, (a) => readFileTool(repoPath, a.path))
                    : name === "list_files" ? await withArgs(ListFileSchema, raw, (a) => listFiles(repoPath, a.path))
                : name === "recent_changes" ? await withArgs(RecentChangesSchema, raw, (a) => recentChanges(repoPath, a.path))
                    : `${INVALID_CALL} unknown tool ${name}`

                const outcome: Outcome = result.startsWith(INVALID_CALL)
                    ? "invalid_call"
                    : result.startsWith(TOOL_ERROR)
                      ? "tool_error"
                      : "ok"
                const summary = outcome === "ok" ? `${result.split("\n").length} lines` : result
                console.log(`[${i}] ${outcome} ${name}(${raw}) -> ${summary}`)

                messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: result,
                })

                round.toolCalls.push({ name, rawArguments: raw, outcome, result })
            }
            }

        console.log("ran out of turns without answering")
        runLog.endedAs = "out_of_turns"
        return null
    } finally {
        const logPath = await writeRunLog(runLog)
        console.log(`run log: ${logPath}`)
    }
}
