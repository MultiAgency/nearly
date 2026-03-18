import {
  CommunitySection,
  CompatibleSection,
  CTASection,
  FeaturesSection,
  HeroSection,
  HowItWorksSection,
  UseCasesSection,
} from '@/components/market';

export default function MarketHomePage() {
  return (
    <>
      <HeroSection />
      <CompatibleSection />
      <HowItWorksSection />
      <UseCasesSection />
      <FeaturesSection />
      <CommunitySection />
      <CTASection />
    </>
  );
}
