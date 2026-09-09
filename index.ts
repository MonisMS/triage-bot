import 'dotenv/config' ;
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import OpenAI from 'openai';
import { join } from 'node:path';

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

const MODEL = "gemini-3.1-flash-lite"

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

Prefer reading a directory's files over guessing what they contain. If you are
about to write "likely contains" or "should contain", read the file instead.

Do not write the fix. Do not output code, patches, shell commands, or
implementations. If you find yourself writing a function, you have
misunderstood the task.

Once you have enough to name the files, stop searching and answer in this shape:
- What the issue is actually asking for, in one or two sentences.
- Up to three files or directories to start with, most likely first. For each,
  say what it does and why it is relevant.
- A concrete first step.

If something remains genuinely unclear after searching, say what it is and what
you would need to look at next.`



const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [ {
    type : "function",
    function:{
        name:"search_code",
        description: "Search the repository for a regex pattern and return the paths of files that contain it. " +
        "Returns file paths only, not matching lines, capped at 20 results. " +
        "Use this to find where a concept lives before recommending files to the developer.",
        parameters:{
            type : "object",
            properties:{
                query:{type :"string",description:"Case-sensitive regex to match against file contents, e.g. 'defineIntegration' or 'zod'.",

                }
            },
            required :["query"]
        }
    }
},{
    type: "function",
    function:{
        name:"read_file",
        description: "Read a file from the repository and return its first 100 lines. " +
        "Takes a path relative to the repository root. " +
        "Use this after search_code to confirm what a file actually contains before recommending it.",
        parameters:{
            type:"object",
            properties:{
                path:{type:"string",description:"Path to the file, relative to the repository root, e.g. 'package.json' or 'packages/stripe/src/index.ts'.",

                }
            },
            required:["path"]
        }

    }
},{
    type: "function",
    function:{
        name:"list_files",
        description: "List file paths in the repository, optionally under a given directory. " +
        "Does not search file contents. Capped at 100 results. " +
        "Use this first to understand the repository's layout before searching or reading.",
        parameters:{
            type:"object",
            properties:{
                path:{type:"string",description:"Directory relative to the repository root, e.g. 'packages' or 'packages/affinda'. Omit to list from the repository root."}
            },
            required:[]
        }
    }
}]
const messages:OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system',content:systemPrompt},
    {role : 'user',content:issue},
]

const searchCode =async (query:string): Promise<string> => {
    
    try {
        const {stdout} = await run("rg",["--files-with-matches", query,"."],{cwd:repoPath})
    return stdout.split("\n").slice(0, 20).join("\n");
    } catch (error) {
        return "no files matched"
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
        const content = readPath.split("\n").slice(0,100).join("\n")
        return content
    } catch (error) {
        return "no such file exists"
    }
}
let answered = false;
for (let i = 0; i < 10; i++) {
    console.log(`[${i}] calling model...`);
    const response = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools,
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
        const args = JSON.parse(call.function.arguments);
        const name = call.function.name
        const result = 
        name === "search_code" ? await searchCode(args.query)
        : name === "read_file" ? await readFileTool(args.path)
        : name === "list_files" ? await listFiles(args.path)
        : `unknown tool ${name}`

        const summary = result.startsWith("ERROR:")
            ? result
            : `${result.split("\n").length} lines`
        console.log(`[${i}] ${name}(${JSON.stringify(args)}) -> ${summary}`);      
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








