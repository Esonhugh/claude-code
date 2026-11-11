import type { Lang } from './i18n'
import type { Recording } from '../../record/convert'
import accountsEn from './recordings/accounts.en.json'
import accountsHans from './recordings/accounts.hans.json'
import accountsZh from './recordings/accounts.zh.json'
import contextEn from './recordings/context.en.json'
import contextHans from './recordings/context.hans.json'
import contextZh from './recordings/context.zh.json'
import goalEn from './recordings/goal.en.json'
import goalHans from './recordings/goal.hans.json'
import goalZh from './recordings/goal.zh.json'
import modsEn from './recordings/mods.en.json'
import modsHans from './recordings/mods.hans.json'
import modsZh from './recordings/mods.zh.json'
import peersEn from './recordings/peers.en.json'
import peersHans from './recordings/peers.hans.json'
import peersZh from './recordings/peers.zh.json'
import teamsEn from './recordings/teams.en.json'
import teamsHans from './recordings/teams.hans.json'
import teamsZh from './recordings/teams.zh.json'
import tmuxEn from './recordings/tmux.en.json'
import tmuxHans from './recordings/tmux.hans.json'
import tmuxZh from './recordings/tmux.zh.json'
import { ReplayTerminal } from './ReplayTerminal'
import { FPS } from './clock'

// Scenes for the scroll-driven tour on the landing page. Each one runs at least TOUR_FRAMES, longer recordings
// play to their end, and the last screen holds for a few seconds before the loop starts over.
export const TOUR_FRAMES = 600
export type Scene = 'accounts' | 'goal' | 'teams' | 'tmux' | 'mods' | 'context' | 'peers'
export const SCENES: Scene[] = ['accounts', 'goal', 'teams', 'tmux', 'mods', 'context', 'peers']

// Scenes recorded from the real CLI in tmux by site/record/record.ts.
const recordings: Record<Scene, Record<Lang, Recording>> = {
  accounts: { en: accountsEn as Recording, zh: accountsZh as Recording, hans: accountsHans as Recording },
  goal: { en: goalEn as Recording, zh: goalZh as Recording, hans: goalHans as Recording },
  teams: { en: teamsEn as Recording, zh: teamsZh as Recording, hans: teamsHans as Recording },
  tmux: { en: tmuxEn as Recording, zh: tmuxZh as Recording, hans: tmuxHans as Recording },
  mods: { en: modsEn as Recording, zh: modsZh as Recording, hans: modsHans as Recording },
  context: { en: contextEn as Recording, zh: contextZh as Recording, hans: contextHans as Recording },
  peers: { en: peersEn as Recording, zh: peersZh as Recording, hans: peersHans as Recording },
}

export function tourFrames(scene: Scene): number {
  const ms = Math.max(...Object.values(recordings[scene]).map(r => r.frames.at(-1)![0]))
  return Math.max(TOUR_FRAMES, Math.ceil(((ms + 3000) / 1000) * FPS))
}

export const TourDemo: React.FC<{ lang: Lang; scene: Scene }> = ({ lang, scene }) => {
  const title = { accounts: 'search-demo — Claude + ChatGPT', peers: 'search-demo — builder + reviewer' }[scene as string] ?? 'search-demo — claude'
  return <ReplayTerminal title={title} recording={recordings[scene][lang]} />
}
