import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'
import cliMd from './run/examples/cli.md' with { type: 'text' }
import electronMd from './run/examples/electron.md' with { type: 'text' }
import libraryMd from './run/examples/library.md' with { type: 'text' }
import playwrightMd from './run/examples/playwright.md' with { type: 'text' }
import serverMd from './run/examples/server.md' with { type: 'text' }
import tuiMd from './run/examples/tui.md' with { type: 'text' }
import runSkillMd from './run/SKILL.md' with { type: 'text' }
import generatorSkillMd from './run-skill-generator/SKILL.md' with { type: 'text' }
import templateMd from './run-skill-generator/template.md' with { type: 'text' }

const RUN_EXAMPLE_FILES: Record<string, string> = {
  'examples/cli.md': cliMd,
  'examples/electron.md': electronMd,
  'examples/library.md': libraryMd,
  'examples/playwright.md': playwrightMd,
  'examples/server.md': serverMd,
  'examples/tui.md': tuiMd,
}

function skillPrompt(skillMd: string, args: string): string {
  const parts = [parseFrontmatter(skillMd).content.trimStart()]
  if (args) parts.push(`## User Request\n\n${args}`)
  return parts.join('\n\n')
}

export function registerRunSkill(): void {
  registerBundledSkill({
    name: 'run',
    menuDescription: 'Launch this project’s app to see your change working',
    description:
      "Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the app, or to confirm a change works in the real app (not just tests). First looks for a project skill that already covers launching the app; otherwise falls back to built-in patterns per project type (CLI, server, TUI, Electron, browser-driven, library).",
    userInvocable: true,
    files: RUN_EXAMPLE_FILES,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: skillPrompt(runSkillMd, args) }]
    },
  })
}

export function registerRunSkillGeneratorSkill(): void {
  registerBundledSkill({
    name: 'run-skill-generator',
    menuDescription: 'Create a skill that knows how to run this project’s app',
    description:
      "Author or improve the run-<unit> skill - a per-project skill that tells agents how to build, launch, and drive this project's app. Use when the user asks to set up the project, get it running, write run instructions, or verify build/run steps work from a clean environment.",
    userInvocable: true,
    disableModelInvocation: true,
    files: { 'template.md': templateMd, ...RUN_EXAMPLE_FILES },
    async getPromptForCommand(args) {
      return [{ type: 'text', text: skillPrompt(generatorSkillMd, args) }]
    },
  })
}
