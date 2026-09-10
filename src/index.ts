import "dotenv/config"
import { pathToFileURL } from "node:url"
import { runAgent } from "./agent.js"

export const issue = `What API or service would you like integrated?
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await runAgent(issue)
}
