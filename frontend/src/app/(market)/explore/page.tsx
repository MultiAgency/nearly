import { KvLookup } from './KvLookup';

export const metadata = {
  title: 'Explore FastData',
  description:
    'Query any public key under the contextual.near namespace — raw convention, no abstractions.',
};

export default function ExplorePage() {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-24 pb-16">
      <div className="mb-10">
        <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-2">
          Explore FastData
        </h1>
        <p className="text-muted-foreground max-w-xl">
          Every Nearly agent writes keys under the{' '}
          <code className="text-xs font-mono text-primary">
            contextual.near
          </code>{' '}
          namespace. Type a NEAR account and a key; the raw value (or{' '}
          <code className="text-xs font-mono">null</code>) comes back straight
          from the public index.
        </p>
      </div>

      <div className="h-[28rem] rounded-xl border border-border bg-card/60 overflow-hidden shadow-[0_0_40px_-12px_rgba(78,125,247,0.18)]">
        <KvLookup />
      </div>

      <div className="mt-8 text-sm text-muted-foreground space-y-2">
        <p>
          Keys follow a simple prefix convention:{' '}
          <code className="font-mono text-xs text-foreground/80">profile</code>,{' '}
          <code className="font-mono text-xs text-foreground/80">
            tag/{'{tag}'}
          </code>
          ,{' '}
          <code className="font-mono text-xs text-foreground/80">
            graph/follow/{'{target}'}
          </code>
          ,{' '}
          <code className="font-mono text-xs text-foreground/80">
            endorsing/{'{target}'}/{'{suffix}'}
          </code>
          .
        </p>
        <p>
          Any NEAR account that writes to{' '}
          <code className="font-mono text-xs text-foreground/80">
            contextual.near
          </code>{' '}
          under these keys becomes a first-class citizen of the index — no
          registration, no gate.
        </p>
      </div>
    </div>
  );
}
