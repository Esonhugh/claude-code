import { Audio } from "@remotion/media";
import { Sequence, staticFile } from "remotion";

export type SfxName = "whoosh" | "impact" | "tick" | "ding" | "riser";

export const Sfx: React.FC<{ name: SfxName; at?: number; volume?: number }> = ({ name, at = 0, volume = 1 }) => (
  <Sequence from={at} layout="none" name={`sfx ${name}`}>
    <Audio src={staticFile(`audio/${name}.wav`)} volume={volume} />
  </Sequence>
);
