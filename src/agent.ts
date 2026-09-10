import OpenAI from "openai"
import { writeRunLog, type Outcome, type RoundLog, type RunLog } from "./log.js"
import { systemPrompt } from "./prompt.js"
import {
    INVALID_CALL,
    ListFileSchema,
    ReadFileSchema,
    SearchCodeSchema,
    TOOL_ERROR,
    listFiles,
    readEnv,
    readFileTool,
    searchCode,
    tools,
    withArgs,
} from "./tools.js"

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

export const runAgent = async (issueText: string): Promise<string | null> => {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: issueText },
    ]

    const runLog: RunLog = {
        startedAt: new Date().toISOString(),
        model: MODEL,
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
            const response = await client.chat.completions.create({
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
                    name === "search_code" ? await withArgs(SearchCodeSchema, raw, (a) => searchCode(a.query))
                    : name === "read_file" ? await withArgs(ReadFileSchema, raw, (a) => readFileTool(a.path))
                    : name === "list_files" ? await withArgs(ListFileSchema, raw, (a) => listFiles(a.path))
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
