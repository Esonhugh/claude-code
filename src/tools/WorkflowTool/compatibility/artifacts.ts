import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkflowExecutorName, WorkflowRunArtifacts } from './types.js'

export async function createCaseWorkspace({
  outputRoot,
  caseId,
  executor,
  attempt,
  fixtureFiles,
}: {
  outputRoot: string
  caseId: string
  executor: WorkflowExecutorName
  attempt: number
  fixtureFiles: Record<string, string>
}): Promise<string> {
  const workspacePath = join(outputRoot, caseId, executor, `attempt-${attempt}`)
  await rm(workspacePath, { recursive: true, force: true })
  await mkdir(workspacePath, { recursive: true })

  for (const [relativePath, content] of Object.entries(fixtureFiles)) {
    const targetPath = join(workspacePath, relativePath)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content)
  }

  return workspacePath
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const absolutePath = join(current, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolutePath)))
    } else {
      const fileStat = await stat(absolutePath)
      files.push(`${absolutePath.slice(root.length + 1)}\t${fileStat.size}`)
    }
  }
  return files.sort()
}

export async function writeExecutorArtifacts({
  workspacePath,
  caseId,
  executor,
  attempt,
  command,
  env,
  stdout,
  stderr,
  metadata,
}: {
  workspacePath: string
  caseId: string
  executor: WorkflowExecutorName
  attempt: number
  command: string[]
  env: Record<string, string>
  stdout: string
  stderr: string
  metadata: Record<string, unknown>
}): Promise<WorkflowRunArtifacts> {
  await mkdir(workspacePath, { recursive: true })

  const stdoutPath = join(workspacePath, 'stdout.txt')
  const stderrPath = join(workspacePath, 'stderr.txt')
  const filesManifestPath = join(workspacePath, 'files.json')
  const metadataPath = join(workspacePath, 'metadata.json')

  await writeFile(stdoutPath, stdout)
  await writeFile(stderrPath, stderr)
  await writeFile(filesManifestPath, `${JSON.stringify(await listFiles(workspacePath), null, 2)}\n`)
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  return {
    caseId,
    executor,
    attempt,
    workspacePath,
    command,
    env,
    stdoutPath,
    stderrPath,
    filesManifestPath,
    metadataPath,
  }
}
