import 'dotenv/config' ;
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const run = promisify(execFile)

const readEnv = (envVar:string|undefined,varName:string):string =>{
if(!envVar){
    throw new Error(`${varName} is missing. Set it in .env`);
    
}
return envVar
}
const repoPath = readEnv(process.env.REPO_PATH, "REPO_PATH");


const client = new OpenAI({
    apiKey:readEnv(process.env.GOOGLE_API_KEY, "GOOGLE_API_KEY"),
    // Overridable so the loop can be driven against a local stub server without
    // spending real quota. Unset in normal use.
    baseURL: process.env.BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
    timeout: 120_000,
    maxRetries: 3,

})

const MODEL = "gemini-3.8-flash"

const issue = `What API or service would you like integrated?
Code Interpreter

API documentation link
https://www.librechat.ai/docs/features/code_interpreter

What would you like to do with this integration?
Code Interpreter API is a tool that allows an AI application to execute code, analyze data, and work with files in a controlled environment. It is especially useful for tasks involving Python programming, data analysis, calculations, charts, and file processing.

Key features:

Execute Python code
Analyze CSV, Excel, and other data files
Create graphs and visualizations
Perform complex calculations
Read and process uploaded files
Help automate data-analysis tasks

Do you need webhook support?

Yes, I need webhook support for this integration

Webhook details (if applicable)
No response

Additional context
No response`

const systemPrompt = `You help a developer find where to start on an unfamiliar codebase.

You are given a GitHub issue. Your job is to identify where in the repository
the work most likely belongs and what the developer should look at first.

You have three tools. Use them before you name any file or directory, and never
recommend one you have not confirmed exists.

- list_files shows the repository's layout. Start here. Call it with no path to
  see the top level, then with a directory to see what is inside it.
- read_file shows the contents of one file. Use it to confirm what a file
  actually does before recommending it.
- search_code finds files whose contents match a regex. Use it when you have a
  distinctive word to look for, not to explore directory structure.

A handful of calls is usually enough. If a path you guessed does not exist, do
not guess another path. Use search_code to find the right one.

Do not claim a file or directory is missing unless you have listed its parent
directory and it was not there.

If the issue names a feature such as webhooks, authentication, or tests, confirm
that any example you recommend actually implements it. List its directory. An
example only demonstrates a feature if there are files implementing it, such as
a dedicated directory or non-empty definitions. A field set to {} or undefined
is not an example of anything. Do not assume a file handles something because it
would make sense for it to.

Before telling the developer to create files by hand, list the scripts directory
and check whether a scaffolding or generator script already exists for this kind
of work.

Prefer reading a directory's files over guessing what they contain. If you are
about to write "likely contains" or "should contain", read the file instead.

Do not write the fix. Do not output code, patches, shell commands, or
implementations. If you find yourself writing a function, you have
misunderstood the task.

Your concrete first step must be something you have not already done. If you
have read a file during this session, do not tell the developer to read it as
their first step. Tell them what you found in it.

Once you have enough to name the files, stop searching and answer in this shape:
- What the issue is actually asking for, in one or two sentences.
- Up to three files or directories to start with, most likely first. For each,
  say what it does and why it is relevant.
- A concrete first step.

If something remains genuinely unclear after searching, say what it is and what
you would need to look at next.`



// A path the model supplies must stay inside repoPath. `cwd` does not enforce
// this: `ls ../..` walks straight out of the repo, and an absolute path ignores
// cwd entirely, while join(repoPath, "/etc") resolves to "/etc". Neither
// TypeScript nor JSON Schema can express this, so it runs on our side.
const insideRepo = (p: string) =>
    !p.startsWith("/") &&
    !/^[A-Za-z]:/.test(p) &&
    !p.split(/[\\/]/).includes("..")
const insideRepoMessage =
    "path must be relative to the repository root: no leading '/', no drive letter, no '..' segments"

const SearchCodeSchema = z.object({
    query: z
        .string()
        .min(1, "query must not be empty")
        .describe(
            "Case-sensitive regex to match against file contents, e.g. 'defineIntegration' or 'zod'."
        ),
})

const ReadFileSchema = z.object({
    path: z
        .string()
        .min(1, "path must not be empty")
        .describe(
            "Path to the file, relative to the repository root, e.g. 'package.json' or 'packages/stripe/src/index.ts'."
        )
        .refine(insideRepo, insideRepoMessage),
})

const ListFileSchema = z.object({
    path: z
        .string()
        .describe(
            "Directory relative to the repository root, e.g. 'packages' or 'packages/affinda'. Omit to list from the repository root."
        )
        .refine(insideRepo, insideRepoMessage)
        .default("."),
})

const toolParams = (schema: z.ZodType<any, any>) => {
    const { $schema, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
    return rest
}

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [ {


    type : "function",
    function:{
        name:"search_code",
        description: "Search the repository for a regex pattern and return the paths of files that contain it. " +
        "Returns file paths only, not matching lines, capped at 20 results. " +
        "Use this to find where a concept lives before recommending files to the developer.",
        parameters: toolParams(SearchCodeSchema)
    }
},{
    type: "function",
    function:{
        name:"read_file",
        description: "Read a file from the repository and return its first 100 lines. " +
        "Takes a path relative to the repository root. " +
        "Use this after search_code to confirm what a file actually contains before recommending it.",
        parameters: toolParams(ReadFileSchema)

    }
},{
    type: "function",
    function:{
        name:"list_files",
        description: "List file paths in the repository, optionally under a given directory. " +
        "Does not search file contents. Capped at 100 results. " +
        "Use this first to understand the repository's layout before searching or reading.",
        parameters: toolParams(ListFileSchema)
    }
}]
// Two different events, kept apart on purpose. INVALID_CALL means the model
// built the call wrong and should retry it. ERROR means the call was well formed
// and the repository answered no, which is a fact about the repository and not
// something a retry fixes.
const INVALID_CALL = "INVALID_CALL:"
const TOOL_ERROR = "ERROR:"

// Line caps do nothing for a minified bundle or a one-line JSON blob, which is
// still a single line no matter how many characters it holds. Cap both.
const MAX_CHARS = 8_000

const truncate = (lines: string[], cap: number, unit: string): string => {
    const kept = lines.slice(0, cap)
    const text = kept.join("\n")
    const droppedLines = lines.length - kept.length

    if (text.length > MAX_CHARS) {
        // Say how much was cut here too. Without a count the model cannot tell a
        // file it has seen in full from one it has seen the first 8k of.
        const droppedChars = text.length - MAX_CHARS
        const andLines = droppedLines > 0 ? `, then ${droppedLines} more ${unit}` : ""
        return `${text.slice(0, MAX_CHARS)}\n... truncated at ${MAX_CHARS} characters: ${droppedChars} more characters${andLines} not shown`
    }

    return text + (droppedLines > 0 ? `\n... ${droppedLines} more ${unit} not shown` : "")
}

// execFile sets `code` to a string like "ENOENT" when the binary itself could
// not be spawned, and to a numeric exit status when it ran and failed. A missing
// binary is neither an invalid call nor a fact about the repository: the model
// cannot act on it, and handing it over burns the turn budget on retries that
// cannot work. Fail loudly instead.
const assertSpawned = (error: unknown, binary: string): void => {
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === "string") {
        throw new Error(`${binary} could not be run (${code}). Is it installed and on PATH?`)
    }
}

// execFile keeps the shell out of it, which stops metacharacters but does
// nothing about argument injection: a value in flag position is still read as a
// flag. `-e` pins the model's query to the pattern slot, and `--` ends flag
// parsing before the path. Without `-e`, a query of "--pre=/tmp/x" is a ripgrep
// flag that runs a program of the model's choosing against every file scanned.
const searchCode = async (query: string): Promise<string> => {
    try {
        const { stdout } = await run(
            "rg",
            ["--files-with-matches", "--hidden", "-e", query, "--", "."],
            { cwd: repoPath },
        )
        const lines = stdout.trim().split("\n").filter(Boolean)
        if (lines.length === 0) return `(no files matched: ${query})`
        return truncate(lines, 20, "files")
    } catch (error) {
        assertSpawned(error, "rg")
        // rg exits 1 for "no matches" and 2 for a real failure such as an
        // unparseable regex. Collapsing the two tells the model the concept is
        // absent from the repository when in fact its own pattern was broken.
        const { code, stderr } = error as { code?: number; stderr?: string }
        if (code === 1) return `(no files matched: ${query})`
        const detail = (stderr ?? String(error)).trim()
        return `${INVALID_CALL} search_code could not run that pattern: ${detail}`
    }
}

const listFiles = async (path: string = "."): Promise<string> => {
    try {
        const { stdout } = await run("ls", ["-1p", "--", path], { cwd: repoPath })
        const lines = stdout.trim().split("\n").filter(Boolean)
        if (lines.length === 0) return `(empty directory: ${path})`
        return truncate(lines, 100, "entries")
    } catch (error) {
        assertSpawned(error, "ls")
        const detail = ((error as { stderr?: string }).stderr ?? String(error)).trim()
        if (/No such file or directory/.test(detail)) return `${TOOL_ERROR} no such directory: ${path}`
        if (/Permission denied/.test(detail)) return `${TOOL_ERROR} permission denied: ${path}`
        return `${TOOL_ERROR} could not list ${path}: ${detail}`
    }
}

const readFileTool = async (path: string): Promise<string> => {
    try {
        const contents = await readFile(join(repoPath, path), "utf-8")
        if (contents.trim() === "") return `(empty file: ${path})`
        return truncate(contents.split("\n"), 100, "lines")
    } catch (error) {
        // ENOENT, EISDIR and EACCES are three different facts about the
        // repository. Reporting all of them as "no such file" makes the model
        // confidently wrong about what exists.
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") return `${TOOL_ERROR} no such file: ${path}`
        if (code === "EISDIR") return `${TOOL_ERROR} that path is a directory, not a file: ${path}`
        if (code === "EACCES") return `${TOOL_ERROR} permission denied: ${path}`
        return `${TOOL_ERROR} could not read ${path}: ${code ?? String(error)}`
    }
}

// The model's `arguments` is a string it generated token by token: it may not be
// JSON at all, and if it is, nothing guarantees the shape. Validate here, at the
// boundary, and hand any failure back to the model as a tool result so it can
// correct itself on the next turn rather than crashing the run.
const withArgs = async <T>(
    schema: z.ZodType<T, any>,
    raw: string,
    invoke: (args: T) => Promise<string>,
): Promise<string> => {
    let json: unknown
    try {
        json = JSON.parse(raw)
    } catch {
        return `${INVALID_CALL} arguments were not valid JSON: ${raw}`
    }

    const parsed = schema.safeParse(json)
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")
        return `${INVALID_CALL} invalid arguments: ${issues}`
    }

    return invoke(parsed.data)
}

const MAX_TURNS = 10
const WARN_AT = 3
const PACE_MS = 13_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const runAgent = async (issueText: string = issue): Promise<string | null> => {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: issueText },
    ]

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

        // An empty tool_calls array is truthy, so testing the array itself burns
        // a turn on a message that adds nothing to the conversation.
        const calls = message.tool_calls ?? []
        if (calls.length === 0) {
            console.log(message.content)
            return message.content ?? null
        }

        for (const call of calls) {
            // Every tool_call needs a matching tool result. Skipping one leaves
            // an assistant message the API rejects on the next request.
            if (call.type !== "function") {
                messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: `${INVALID_CALL} unsupported tool call type: ${call.type}`,
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

            const outcome = result.startsWith(INVALID_CALL)
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
        }
    }

    console.log("ran out of turns without answering")
    return null
}

// Only run the loop when this file is the entry point, so it can also be
// imported and driven more than once.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await runAgent()
}
