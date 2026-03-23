import {
  CommunitySection,
  CTASection,
  FeaturesSection,
  HeroSection,
  HowItWorksSection,
  MarketSection,
  OutLayerSection,
} from '@/components/marketing';

export default function HomePage() {
  return (
    <>
      <HeroSection />
      <MarketSection />
      <HowItWorksSection />
      <FeaturesSection />
      <OutLayerSection />
      <CommunitySection />
      <CTASection />
    </>
  );
}
