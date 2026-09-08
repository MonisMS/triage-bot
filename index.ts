import 'dotenv/config' ;
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import OpenAI from 'openai';

const run = promisify(execFile)
const repoPath = process.env.REPO_PATH
const readApiKey = (apiKey:string|undefined):string =>{
if(!apiKey){
    throw new Error("GOOGLE_API_KEY is missing. Set it in .env");
    
}
return apiKey
}

const client = new OpenAI({
    apiKey: readApiKey(process.env.GOOGLE_API_KEY),
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    timeout: 120_000,
    maxRetries: 3,

})

const MODEL = "gemini-3.1-flash-lite"

const issue = `What API or service would you like integrated?
OCR.space

API documentation link
https://ocr.space/OCRAPI

What would you like to do with this integration?
Add an OCR.space plugin for Corsair with the currently listed OSS API surface:

Extract text from an image URL with the simplified GET endpoint
Extract text from an image, PDF, URL, or base64 payload with the POST endpoint
Retrieve conversion statistics for accounts that support that endpoint
The plugin should expose read-only operations with zod input/output schemas, API-key authentication, and provider-aware error handling.

Do you need webhook support?
No. OCR.space is a request/response OCR API and the Corsair OSS page lists 0 triggers/webhooks for this integration.

Additional context
Authentication is via API key. The implementation should avoid hardcoded credentials, keep test coverage inside packages/ocrspace, and follow the plugin PR rules in .github/PLUGIN_PR_RULES.md.`

const systemPrompt = `You help a developer find where to start on an unfamiliar codebase.

You are given a GitHub issue. Your job is to identify where in the repository
the work most likely belongs and what the developer should look at first.

You can search the repository with the search_code tool. Use it. Search before
you name any file or directory, and never recommend one you have not confirmed
exists. If a search returns nothing, try a different term rather than assuming.
Two or three searches is usually enough.

Do not write the fix. Do not output code, patches, or implementations. If you
find yourself writing a function, you have misunderstood the task.

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
}]
const messages:OpenAI.Chat.ChatCompletionMessageParam[] = [
    {role: 'system',content:systemPrompt},
    {role : 'user',content:issue},
]

const searchCode =async (query:string): Promise<string> => {
    
    try {
        const {stdout,stderr} = await run("rg",["--files-with-matches", query,"."],{cwd:repoPath})
    return stdout.split("\n").slice(0, 20).join("\n");
    } catch (error) {
        return "no files matched"
    }
}


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
        break
        
    }
    
    for (const call of message.tool_calls) {
        if (call.type !== "function") continue;
        const args = JSON.parse(call.function.arguments);
        const result = await searchCode(args.query);

        console.log(`[${i}] search_code("${args.query}") -> ${result.split("\n").length} files`);
      
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
    
}








