import type { Command } from '../../commands.js'

const heapDump = {
  type: 'local',
  name: 'heapdump',
  description:
    'Dump the JS heap to the Desktop; on Linux with no Desktop folder, the home directory',
  isHidden: true,
  supportsNonInteractive: true,
  load: () => import('./heapdump.js'),
} satisfies Command

export default heapDump
