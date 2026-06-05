import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isENOENT } from '../../utils/errors.js'

export type WorkflowRunTemplate = {
  name: string
  selector: string
  runArgs: string
}

type WorkflowRunTemplateFile = {
  templates: WorkflowRunTemplate[]
}

function templatePath(cwd: string): string {
  return join(cwd, '.claude', 'workflow-run-templates.json')
}

function sanitizeTemplateName(name: string): string {
  const value = name.trim()
  if (!/^[A-Za-z0-9:_-]+$/.test(value)) {
    throw new Error('Workflow run template name must contain only letters, numbers, colon, underscore, or dash')
  }
  return value
}

async function readTemplateFile(cwd: string): Promise<WorkflowRunTemplateFile> {
  try {
    const parsed = JSON.parse(await readFile(templatePath(cwd), 'utf8')) as WorkflowRunTemplateFile
    return { templates: Array.isArray(parsed.templates) ? parsed.templates : [] }
  } catch (error) {
    if (isENOENT(error)) return { templates: [] }
    throw error
  }
}

async function writeTemplateFile(cwd: string, file: WorkflowRunTemplateFile): Promise<void> {
  const path = templatePath(cwd)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`)
}

export async function listWorkflowRunTemplates(cwd: string): Promise<WorkflowRunTemplate[]> {
  return (await readTemplateFile(cwd)).templates.sort((a, b) => a.name.localeCompare(b.name))
}

export async function saveWorkflowRunTemplate({
  cwd,
  name,
  selector,
  runArgs,
}: {
  cwd: string
  name: string
  selector: string
  runArgs: string
}): Promise<WorkflowRunTemplate> {
  const template = {
    name: sanitizeTemplateName(name),
    selector: selector.trim(),
    runArgs: runArgs.trim(),
  }
  if (!template.selector) {
    throw new Error('Workflow run template selector is required')
  }

  const file = await readTemplateFile(cwd)
  await writeTemplateFile(cwd, {
    templates: [
      ...file.templates.filter(existing => existing.name !== template.name),
      template,
    ].sort((a, b) => a.name.localeCompare(b.name)),
  })
  return template
}

export async function loadWorkflowRunTemplate(cwd: string, name: string): Promise<WorkflowRunTemplate> {
  const templateName = sanitizeTemplateName(name)
  const template = (await readTemplateFile(cwd)).templates.find(item => item.name === templateName)
  if (!template) {
    throw new Error(`Workflow run template not found: ${templateName}`)
  }
  return template
}
