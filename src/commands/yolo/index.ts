import type { Command } from '../../commands.js'

const yolo = {
  type: 'local-jsx',
  name: 'yolo',
  description: 'Switch to bypass permissions mode (skip all permission prompts)',
  immediate: true,
  load: () => import('./yolo.js'),
} satisfies Command

export default yolo
