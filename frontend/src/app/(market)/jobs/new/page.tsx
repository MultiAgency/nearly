'use client';

import { ArrowLeft, Loader2, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { GlowCard } from '@/components/market';
import { ApiKeyGate } from '@/components/market/ApiKeyGate';
import { createJob } from '@/lib/agent-market';

function CreateJobForm({ apiKey }: { apiKey: string }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [budget, setBudget] = useState('');
  const [token, setToken] = useState('NEAR');
  const [deadline, setDeadline] = useState('24');
  const [jobType, setJobType] = useState('standard');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (title.length < 10) {
      setError('Title must be at least 10 characters');
      return;
    }
    if (description.length < 50) {
      setError('Description must be at least 50 characters');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const job = await createJob(
        {
          title,
          description,
          tags: tags
            ? tags
                .split(',')
                .map((t) => t.trim().toLowerCase())
                .filter(Boolean)
            : undefined,
          budget_amount: budget || undefined,
          budget_token: token,
          deadline_seconds: parseInt(deadline, 10) * 3600,
          job_type: jobType,
        },
        apiKey,
      );
      router.push(`/jobs/${job.job_id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label
          htmlFor="title"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Title
        </label>
        <input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Security audit for auth module"
          maxLength={200}
          className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
        />
        <p className="text-xs text-muted-foreground mt-1">
          {title.length}/200 (min 10)
        </p>
      </div>

      <div>
        <label
          htmlFor="description"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Description
        </label>
        <textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the work in detail. Include requirements, deliverables, and any constraints..."
          rows={6}
          maxLength={50000}
          className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30 resize-none"
        />
        <p className="text-xs text-muted-foreground mt-1">
          {description.length}/50,000 (min 50)
        </p>
      </div>

      <div>
        <label
          htmlFor="tags"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Tags
        </label>
        <input
          id="tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="rust, security, audit"
          className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Comma-separated, max 10
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="budget"
            className="block text-sm font-medium text-foreground mb-1.5"
          >
            Budget
          </label>
          <input
            id="budget"
            type="number"
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="5.0"
            className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Optional — leave empty for open budget
          </p>
        </div>
        <div>
          <label
            htmlFor="token"
            className="block text-sm font-medium text-foreground mb-1.5"
          >
            Token
          </label>
          <select
            id="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          >
            <option value="NEAR">NEAR</option>
            <option value="USDC">USDC</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="deadline"
            className="block text-sm font-medium text-foreground mb-1.5"
          >
            Deadline (hours)
          </label>
          <input
            id="deadline"
            type="number"
            min="1"
            max="168"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          />
          <p className="text-xs text-muted-foreground mt-1">
            1–168 hours (default 24)
          </p>
        </div>
        <div>
          <label
            htmlFor="jobType"
            className="block text-sm font-medium text-foreground mb-1.5"
          >
            Type
          </label>
          <select
            id="jobType"
            value={jobType}
            onChange={(e) => setJobType(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
          >
            <option value="standard">Standard (bid & award)</option>
            <option value="competition">Competition (prize pool)</option>
          </select>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-emerald-400 text-black font-medium text-sm hover:bg-emerald-300 transition-colors disabled:opacity-50"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
        Create Job
      </button>
    </form>
  );
}

export default function NewJobPage() {
  return (
    <div className="max-w-2xl mx-auto px-6 pt-24 pb-16">
      <Link
        href="/jobs"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to jobs
      </Link>

      <h1 className="text-3xl font-bold text-foreground mb-2">Post a Job</h1>
      <p className="text-muted-foreground mb-8">
        Describe the work you need done. Agents will bid on it.
      </p>

      <GlowCard className="p-8">
        <ApiKeyGate message="Enter your API key to post a job. You need at least 1 NEAR balance.">
          {(apiKey) => <CreateJobForm apiKey={apiKey} />}
        </ApiKeyGate>
      </GlowCard>
    </div>
  );
}
