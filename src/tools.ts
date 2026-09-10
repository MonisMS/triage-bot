import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type OpenAI from "openai"
import { z } from "zod"

const run = promisify(execFile)

export const INVALID_CALL = "INVALID_CALL:"
export const TOOL_ERROR = "ERROR:"

export const insideRepo = (p: string) =>
    !p.startsWith("/") &&
    !/^[A-Za-z]:/.test(p) &&
    !p.split(/[\\/]/).includes("..")

export const insideRepoMessage =
    "path must be relative to the repository root: no leading '/', no drive letter, no '..' segments"

export const SearchCodeSchema = z.object({
    query: z
        .string()
        .min(1, "query must not be empty")
        .describe(
            "Case-sensitive regex to match against file contents, e.g. 'defineIntegration' or 'zod'."
        ),
})

export const ReadFileSchema = z.object({
    path: z
        .string()
        .min(1, "path must not be empty")
        .describe(
            "Path to the file, relative to the repository root, e.g. 'package.json' or 'packages/stripe/src/index.ts'."
        )
        .refine(insideRepo, insideRepoMessage),
})

export const ListFileSchema = z.object({
    path: z
        .string()
        .describe(
            "Directory relative to the repository root, e.g. 'packages' or 'packages/affinda'. Omit to list from the repository root."
        )
        .refine(insideRepo, insideRepoMessage)
        .default("."),
})

export const RecentChangesSchema = z.object({
    path: z
        .string()
        .min(1, "path must not be empty")
        .describe(
            "Path to a file or directory, relative to the repository root, e.g. 'packages/corsair/core/constants.ts' or 'packages/corsair'."
        )
        .refine(insideRepo, insideRepoMessage),
})

export const toolParams = (schema: z.ZodType<any, any>) => {
    const { $schema, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
    return rest
}

export const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "search_code",
            description: "Search the repository for a regex pattern and return the paths of files that contain it. " +
            "Returns file paths only, not matching lines, capped at 20 results. " +
            "Use this to find where a concept lives before recommending files to the developer.",
            parameters: toolParams(SearchCodeSchema),
        },
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read a file from the repository and return its first 100 lines. " +
            "Takes a path relative to the repository root. " +
            "Use this after search_code to confirm what a file actually contains before recommending it.",
            parameters: toolParams(ReadFileSchema),
        },
    },
    {
        type: "function",
        function: {
            name: "recent_changes",
            description: "Show the last 5 commits that touched a file or directory, with the short hash, author, relative date and subject. " +
            "Takes a path relative to the repository root. " +
            "Use this to find who last worked on an area and how recently, before recommending it to the developer.",
            parameters: toolParams(RecentChangesSchema),
        },
    },
    {
        type: "function",
        function: {
            name: "list_files",
            description: "List file paths in the repository, optionally under a given directory. " +
            "Does not search file contents. Capped at 100 results. " +
            "Use this first to understand the repository's layout before searching or reading.",
            parameters: toolParams(ListFileSchema),
        },
    },
]

const MAX_CHARS = 8_000

export const truncate = (lines: string[], cap: number, unit: string): string => {
    const kept = lines.slice(0, cap)
    const text = kept.join("\n")
    const droppedLines = lines.length - kept.length

    if (text.length > MAX_CHARS) {
        const droppedChars = text.length - MAX_CHARS
        const andLines = droppedLines > 0 ? `, then ${droppedLines} more ${unit}` : ""
        return `${text.slice(0, MAX_CHARS)}\n... truncated at ${MAX_CHARS} characters: ${droppedChars} more characters${andLines} not shown`
    }

    return text + (droppedLines > 0 ? `\n... ${droppedLines} more ${unit} not shown` : "")
}

const assertSpawned = (error: unknown, binary: string): void => {
    const code = (error as NodeJS.ErrnoException).code
    if (typeof code === "string") {
        throw new Error(`${binary} could not be run (${code}). Is it installed and on PATH?`)
    }
}

export const searchCode = async (repoPath: string, query: string): Promise<string> => {
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
        const { code, stderr } = error as { code?: number; stderr?: string }
        if (code === 1) return `(no files matched: ${query})`
        const detail = (stderr ?? String(error)).trim()
        return `${INVALID_CALL} search_code could not run that pattern: ${detail}`
    }
}

export const listFiles = async (repoPath: string, path: string = "."): Promise<string> => {
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

export const readFileTool = async (repoPath: string, path: string): Promise<string> => {
    try {
        const contents = await readFile(join(repoPath, path), "utf-8")
        if (contents.trim() === "") return `(empty file: ${path})`
        return truncate(contents.split("\n"), 100, "lines")
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT") return `${TOOL_ERROR} no such file: ${path}`
        if (code === "EISDIR") return `${TOOL_ERROR} that path is a directory, not a file: ${path}`
        if (code === "EACCES") return `${TOOL_ERROR} permission denied: ${path}`
        return `${TOOL_ERROR} could not read ${path}: ${code ?? String(error)}`
    }
}

export const recentChanges = async (repoPath: string, path: string): Promise<string> => {
    try {
        const { stdout } = await run(
            "git",
            ["log", "-n", "5", "--format=%h  %an, %ar:  %s", "--", path],
            { cwd: repoPath },
        )
        const lines = stdout.trim().split("\n").filter(Boolean)
        if (lines.length === 0) return `(no commits found for: ${path})`
        return truncate(lines, 5, "commits")
    } catch (error) {
        assertSpawned(error, "git")
        const detail = ((error as { stderr?: string }).stderr ?? String(error)).trim()
        return `${TOOL_ERROR} could not read history for ${path}: ${detail}`
    }
}

export const withArgs = async <T>(
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
