import { z } from "zod"

export type IssueRef = z.infer<typeof IssueRefSchema>

const IssueRefSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    number: z.number().int().positive(),
})

const URL_PATTERN = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)/
const SHORTHAND_PATTERN = /^([^/\s]+)\/([^/#\s]+)#(\d+)$/

export const parseIssueRef = (input: string): IssueRef => {
    const trimmed = input.trim()

    const url = URL_PATTERN.exec(trimmed)
    if (url) {
        if (url[3] === "pull") {
            throw new Error(
                `that is a pull request URL, not an issue: ${trimmed}\n` +
                `Pass the issue instead, e.g. https://github.com/${url[1]}/${url[2]}/issues/123`,
            )
        }
        return IssueRefSchema.parse({ owner: url[1], repo: url[2], number: Number(url[4]) })
    }

    const shorthand = SHORTHAND_PATTERN.exec(trimmed)
    if (shorthand) {
        return IssueRefSchema.parse({
            owner: shorthand[1],
            repo: shorthand[2],
            number: Number(shorthand[3]),
        })
    }

    throw new Error(
        `could not parse "${input}".\n` +
        `Expected https://github.com/owner/repo/issues/123 or owner/repo#123`,
    )
}

export const fetchIssue = async (ref: IssueRef): Promise<string> => {
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`
    const token = process.env.GITHUB_TOKEN

    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "triage-agent",
    }
    if (token) {
        headers.Authorization = `Bearer ${token}`
    }

    const response = await fetch(url, { headers })

    if (response.status === 404) {
        throw new Error(
            `no such issue: ${ref.owner}/${ref.repo}#${ref.number}. ` +
            `It does not exist, or the repository is private` +
            (token ? "." : " and GITHUB_TOKEN is not set."),
        )
    }

    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
        const reset = response.headers.get("x-ratelimit-reset")
        const at = reset ? new Date(Number(reset) * 1000).toISOString() : "an unknown time"
        throw new Error(
            `GitHub rate limit exhausted, resets at ${at}. ` +
            (token
                ? "The token in GITHUB_TOKEN is already being used."
                : "Set GITHUB_TOKEN to raise the limit from 60 to 5000 requests an hour."),
        )
    }

    if (!response.ok) {
        throw new Error(
            `GitHub returned ${response.status} ${response.statusText} for ${url}`,
        )
    }

    const data = (await response.json()) as {
        title?: string
        body?: string | null
        pull_request?: unknown
    }

    if (data.pull_request) {
        throw new Error(
            `${ref.owner}/${ref.repo}#${ref.number} is a pull request, not an issue. ` +
            `The issues endpoint returns pull requests too, so the URL looked valid.`,
        )
    }

    const title = data.title?.trim() || "(no title)"
    const body = data.body?.trim() || "(no description)"
    return `${title}\n\n${body}`
}
