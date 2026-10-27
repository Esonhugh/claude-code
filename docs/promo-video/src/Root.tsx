import { Composition } from "remotion";
import { PROMO_DURATION, PromoVideo } from "./PromoVideo";

export const RemotionRoot: React.FC = () => (
  <Composition id="PromoVideo" component={PromoVideo} durationInFrames={PROMO_DURATION} fps={30} width={1920} height={1080} />
);
