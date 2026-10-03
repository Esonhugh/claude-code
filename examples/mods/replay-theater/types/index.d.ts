export type ReplayStep = { file: string; before: string; after: string };

export type Replay = { steps: ReplayStep[]; seen: boolean };

declare module "claude-code" {
  interface PluginState {
    "replay-theater": { replay: Replay; step: number };
  }
}
