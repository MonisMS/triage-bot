import "dotenv/config"
import { pathToFileURL } from "node:url"
import { runAgent } from "./agent.js"
import { ensureClone } from "./clone.js"
import { fetchIssue, parseIssueRef } from "./github.js"

const main = async (input: string | undefined): Promise<void> => {
    if (!input) {
        console.error("usage: pnpm dev <github issue url | owner/repo#123>")
        console.error("  e.g. pnpm dev https://github.com/owner/repo/issues/123")
        console.error("       pnpm dev owner/repo#123")
        process.exit(1)
    }

    const ref = parseIssueRef(input)
    console.log(`issue: ${ref.owner}/${ref.repo}#${ref.number}`)

    const issueText = await fetchIssue(ref)
    const repoPath = await ensureClone(ref.owner, ref.repo)

    await runAgent(issueText, repoPath, ref)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main(process.argv[2])
}
