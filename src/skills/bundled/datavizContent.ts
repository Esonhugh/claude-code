// Content for the dataviz bundled skill (official 2.1.303).
// Each file is inlined as a string via Bun's text loader (also under bun test,
// where a plain .md import would be rendered to HTML).

import antiPatternsMd from './dataviz/references/anti-patterns.md' with { type: 'text' }
import choosingAFormMd from './dataviz/references/choosing-a-form.md' with { type: 'text' }
import colorFormulaMd from './dataviz/references/color-formula.md' with { type: 'text' }
import componentsMd from './dataviz/references/components.md' with { type: 'text' }
import interactionMd from './dataviz/references/interaction.md' with { type: 'text' }
import marksAndAnatomyMd from './dataviz/references/marks-and-anatomy.md' with { type: 'text' }
import paletteMd from './dataviz/references/palette.md' with { type: 'text' }
import validatePaletteJs from './dataviz/scripts/validate_palette.js.txt' with { type: 'text' }
import validatePalettePy from './dataviz/scripts/validate_palette.py.txt' with { type: 'text' }
import skillMd from './dataviz/SKILL.md' with { type: 'text' }

export const SKILL_MD: string = skillMd

export const SKILL_FILES: Record<string, string> = {
  'references/anti-patterns.md': antiPatternsMd,
  'references/choosing-a-form.md': choosingAFormMd,
  'references/color-formula.md': colorFormulaMd,
  'references/components.md': componentsMd,
  'references/interaction.md': interactionMd,
  'references/marks-and-anatomy.md': marksAndAnatomyMd,
  'references/palette.md': paletteMd,
  'scripts/validate_palette.js': validatePaletteJs,
  'scripts/validate_palette.py': validatePalettePy,
}
