import {
  CommunitySection,
  CTASection,
  FeaturesSection,
  HeroSection,
  HowItWorksSection,
  MarketSection,
  OutLayerSection,
} from '@/components/marketing';
import { fetchLiveGraphSnapshot } from '@/components/marketing/live-graph/graph-snapshot-server';

const SNAPSHOT_SSR_TIMEOUT_MS = 3_000;

export default async function HomePage() {
  // Fetch the hero graph server-side so first paint has real nodes + edges.
  // Bounded to 3s so a slow FastData doesn't block the whole page render —
  // on timeout we return null and the client hook takes over. Timer is
  // cleared in fetch's `.finally` so a win doesn't leave a dangling
  // setTimeout in the Next.js worker.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const initialGraphData = await Promise.race([
    fetchLiveGraphSnapshot().finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SNAPSHOT_SSR_TIMEOUT_MS);
    }),
  ]);

  return (
    <>
      <HeroSection initialGraphData={initialGraphData} />
      <MarketSection />
      <HowItWorksSection />
      <FeaturesSection />
      <OutLayerSection />
      <CommunitySection />
      <CTASection />
    </>
  );
}
