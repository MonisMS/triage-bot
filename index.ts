import 'dotenv/config' ;
import OpenAI from 'openai';


const readApiKey = (apiKey:string|undefined):string =>{
if(!apiKey){
    throw new Error("GOOGLE_API_KEY is missing. Set it in .env");
    
}
return apiKey
}

const client = new OpenAI({
    apiKey: readApiKey(process.env.GOOGLE_API_KEY),
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",

})

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

Do not write the fix. Do not output code, patches, or implementations. If you
find yourself writing a function, you have misunderstood the task.

Answer in this shape:
- What the issue is actually asking for, in one or two sentences.
- Up to three files or directories to start with, most likely first. For each,
  say what it does and why it is relevant.
- A concrete first step.

Be explicit about uncertainty. If you are guessing because you have not seen
the code, say so and say what you would need to look at to be sure.`
const response = await client.chat.completions.create({
    model:"gemini-3.6-flash",
    messages:[
        {role: 'system',content:systemPrompt},
        {role : 'user',content:issue}
    ]
})

console.log(response.choices[0]?.message.content);
