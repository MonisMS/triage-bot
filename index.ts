import 'dotenv/config' ;
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import { join } from 'node:path';
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
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
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
// this: `ls ../..` resolves relative to cwd and walks straight out of the repo,
// and join(repoPath, "../..") does the same. Neither TypeScript nor JSON Schema
// can express this, so it lives in a refinement that runs on our side.
const insideRepo = (p: string) => !p.split(/[\\/]/).includes("..")
const insideRepoMessage = "path must stay inside the repository: no '..' segments"

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
// Zod stamps a "$schema" key onto its output. Some providers reject unknown keys
// in a tool's `parameters`, and the model never needs it, so drop it.
// io:"input" matters here: `parameters` describes what the model SENDS, and with
// Zod's default io:"output" a .default() field is emitted as required.
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
const messages:OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system',content:systemPrompt},
    {role : 'user',content:issue},
]

const searchCode =async (query:string): Promise<string> => {
    
    try {
        const {stdout} = await run("rg",["--files-with-matches","--hidden", query,"."],{cwd:repoPath})
        const lines = stdout.trim().split("\n")
        const shown = lines.slice(0, 20)
        return shown.join("\n") +
            (lines.length > 20 ? `\n... ${lines.length - 20} more files not shown` : "")
    } catch (error) {
        return `ERROR: no files matched: ${query}`
    }
}

const listFiles = async (path: string = "."): Promise<string> => {
    try {
        const { stdout } = await run("ls", ["-1p", path], { cwd: repoPath })
        const lines = stdout.trim().split("\n")
        const shown = lines.slice(0, 100)
        return shown.join("\n") +
            (lines.length > 100 ? `\n... ${lines.length - 100} more entries not shown` : "")
    } catch (error) {
        return `ERROR: no such directory: ${path}`
    }
}

const readFileTool = async(path:string):Promise<string> =>{
    try {
        const fullPath = join(repoPath,path)
        const readPath = await readFile(fullPath,"utf-8")
        const lines = readPath.split("\n")
        const shown = lines.slice(0, 100)
        return shown.join("\n") +
            (lines.length > 100 ? `\n... ${lines.length - 100} more lines not shown` : "")
    } catch (error) {
        return `ERROR: no such file: ${path}`
    }
}
// The model's `arguments` is a string it generated token by token: it may not be
// JSON at all, and if it is, nothing guarantees the shape. Validate here, at the
// boundary, and hand any failure back to the model as a tool result so it can
// correct itself on the next turn rather than crashing the run.
const withArgs = async <T>(
    schema: z.ZodType<T, any>,
    raw: string,
    run: (args: T) => Promise<string>,
): Promise<string> => {
    let json: unknown
    try {
        json = JSON.parse(raw)
    } catch {
        return `ERROR: arguments were not valid JSON: ${raw}`
    }

    const parsed = schema.safeParse(json)
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")
        return `ERROR: invalid arguments: ${issues}`
    }

    return run(parsed.data)
}

const MAX_TURNS = 10
const WARN_AT = 3
const PACE_MS = 13_000

const sleep = (ms:number) => new Promise(r => setTimeout(r, ms))

let answered = false;
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

    console.log(`[${i}] calling model...${isLastTurn ? " (final, no tools)" : ""}`);
    const response = await client.chat.completions.create({
        model: MODEL,
        messages,
        ...(isLastTurn ? {} : { tools }),
    })
    const message = response.choices[0]?.message
    if(!message){
        throw new Error("no message in response")
    }
    messages.push(message)
    if(!message.tool_calls){
        console.log(message.content);
        answered = true;
        break
        
    }
  
    for (const call of message.tool_calls) {
        if (call.type !== "function") continue;
        const name = call.function.name
        const raw = call.function.arguments

        const result =
        name === "search_code" ? await withArgs(SearchCodeSchema, raw, (a) => searchCode(a.query))
        : name === "read_file" ? await withArgs(ReadFileSchema, raw, (a) => readFileTool(a.path))
        : name === "list_files" ? await withArgs(ListFileSchema, raw, (a) => listFiles(a.path))
        : `ERROR: unknown tool ${name}`

        const summary = result.startsWith("ERROR:")
            ? result
            : `${result.split("\n").length} lines`
        console.log(`[${i}] ${name}(${raw}) -> ${summary}`);      
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
      
}
if (!answered) {
    console.log("ran out of turns without answering");
}








