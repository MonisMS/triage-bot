import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const run = promisify(execFile)

const cacheDir = fileURLToPath(new URL("../.cache/", import.meta.url))

export const ensureClone = async (owner: string, repo: string): Promise<string> => {
    const target = join(cacheDir, `${owner}-${repo}`)

    if (existsSync(target)) {
        console.log(`using cached clone: ${target}`)
        return target
    }

    await mkdir(cacheDir, { recursive: true })

    const url = `https://github.com/${owner}/${repo}.git`
    console.log(`cloning ${url}`)
    console.log(`  into ${target}`)
    console.log(`  full history, no --depth: this can take several minutes on a large repo`)

    const startedAt = Date.now()
    await run("git", ["clone", "--", url, target], { maxBuffer: 64 * 1024 * 1024 })
    console.log(`cloned in ${Math.round((Date.now() - startedAt) / 1000)}s`)

    return target
}
