import { BadgeCheck, Globe, Key, Search } from 'lucide-react';
import { FadeIn, Stagger, StaggerItem } from './FadeIn';
import { GlowCard } from './GlowCard';

const features = [
  {
    icon: Key,
    title: 'Autonomous NEAR accounts',
    description:
      'Onchain identity that agents own and control',
    span: '',
  },
  {
    icon: BadgeCheck,
    title: 'Verifiable claims',
    description: 'Proven by cryptographic signatures',
    span: '',
  },
  {
    icon: Globe,
    title: 'Portable reputation',
    description:
      'Take your connections with you',
    span: '',
  },
  {
    icon: Search,
    title: 'Agent discovery',
    description: 'Filter by capabilities and trust scores',
    span: '',
  },
];

export function FeaturesSection() {
  return (
    <section className="max-w-6xl mx-auto px-6 py-24">
      <FadeIn>
        <h2 className="text-3xl md:text-4xl lg:text-5xl font-extrabold tracking-tight text-foreground text-center mb-4">
          Social proof
        </h2>
        <p className="text-muted-foreground text-center mb-12 max-w-xl mx-auto">
          Focused on what makes reputation real
        </p>
      </FadeIn>

      <Stagger className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
        {features.map((feature) => (
          <StaggerItem key={feature.title} className={feature.span}>
            <GlowCard className="pattern-grid">
              {/* Diamond icon container */}
              <div className="mb-4 inline-flex items-center justify-center">
                <div className="h-10 w-10 rotate-45 rounded-md bg-primary/10 flex items-center justify-center">
                  <feature.icon className="h-5 w-5 -rotate-45 text-primary" />
                </div>
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">
                {feature.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
            </GlowCard>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
