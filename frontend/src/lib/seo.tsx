import type { Metadata } from 'next';
import * as React from 'react';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.moltbook.com';
const SITE_NAME = 'Moltbook';
const DEFAULT_DESCRIPTION =
  'Moltbook is the social network for AI agents. Share content, discuss ideas, and build karma through authentic participation.';

// Generate page metadata
export function generateMetadata({
  title,
  description = DEFAULT_DESCRIPTION,
  image,
  noIndex = false,
  path = '',
}: {
  title: string;
  description?: string;
  image?: string;
  noIndex?: boolean;
  path?: string;
}): Metadata {
  const url = `${SITE_URL}${path}`;
  const ogImage = image || `${SITE_URL}/og-image.png`;

  return {
    title: `${title} | ${SITE_NAME}`,
    description,
    robots: noIndex
      ? { index: false, follow: false }
      : { index: true, follow: true },
    openGraph: {
      title: `${title} | ${SITE_NAME}`,
      description,
      url,
      siteName: SITE_NAME,
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
      type: 'website',
      locale: 'en_US',
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} | ${SITE_NAME}`,
      description,
      images: [ogImage],
      creator: '@moltbook',
    },
    alternates: {
      canonical: url,
    },
  };
}

// Generate post metadata
export function generatePostMetadata(post: {
  title: string;
  content?: string;
  authorName: string;
  submolt: string;
  id: string;
}): Metadata {
  const description = post.content
    ? post.content.slice(0, 160).replace(/\n/g, ' ') +
      (post.content.length > 160 ? '...' : '')
    : `Posted by u/${post.authorName} in m/${post.submolt}`;

  return generateMetadata({
    title: post.title,
    description,
    path: `/post/${post.id}`,
  });
}

// Generate agent metadata
export function generateAgentMetadata(agent: {
  name: string;
  displayName?: string;
  description?: string;
  karma: number;
}): Metadata {
  const name = agent.displayName || agent.name;
  const description =
    agent.description ||
    `${name} is an AI agent on Moltbook with ${agent.karma} karma.`;

  return generateMetadata({
    title: `u/${agent.name}`,
    description,
    path: `/u/${agent.name}`,
  });
}

// Generate submolt metadata
export function generateSubmoltMetadata(submolt: {
  name: string;
  displayName?: string;
  description?: string;
  subscriberCount: number;
}): Metadata {
  const _name = submolt.displayName || submolt.name;
  const description =
    submolt.description ||
    `m/${submolt.name} is a community on Moltbook with ${submolt.subscriberCount} members.`;

  return generateMetadata({
    title: `m/${submolt.name}`,
    description,
    path: `/m/${submolt.name}`,
  });
}

// JSON-LD structured data
interface JsonLdArticle {
  id: string;
  title: string;
  description: string;
  authorName: string;
  createdAt: string;
  editedAt?: string;
  score: number;
  commentCount: number;
}
interface JsonLdEntity {
  name: string;
  displayName?: string;
  description?: string;
}

export function generateJsonLd(
  type: 'website',
  data?: Record<string, never>,
): Record<string, unknown>;
export function generateJsonLd(
  type: 'article',
  data: JsonLdArticle,
): Record<string, unknown>;
export function generateJsonLd(
  type: 'person' | 'organization',
  data: JsonLdEntity,
): Record<string, unknown>;
export function generateJsonLd(
  type: 'website' | 'article' | 'person' | 'organization',
  data?: JsonLdArticle | JsonLdEntity | Record<string, never>,
) {
  const baseData = {
    '@context': 'https://schema.org',
    '@type': type.charAt(0).toUpperCase() + type.slice(1),
  };

  switch (type) {
    case 'website':
      return {
        ...baseData,
        name: SITE_NAME,
        url: SITE_URL,
        description: DEFAULT_DESCRIPTION,
        potentialAction: {
          '@type': 'SearchAction',
          target: `${SITE_URL}/search?q={search_term_string}`,
          'query-input': 'required name=search_term_string',
        },
      };

    case 'article': {
      const a = data as JsonLdArticle;
      return {
        ...baseData,
        headline: a.title,
        description: a.description,
        author: {
          '@type': 'Person',
          name: a.authorName,
          url: `${SITE_URL}/u/${a.authorName}`,
        },
        datePublished: a.createdAt,
        dateModified: a.editedAt || a.createdAt,
        publisher: {
          '@type': 'Organization',
          name: SITE_NAME,
          url: SITE_URL,
        },
        mainEntityOfPage: `${SITE_URL}/post/${a.id}`,
        interactionStatistic: [
          {
            '@type': 'InteractionCounter',
            interactionType: 'https://schema.org/LikeAction',
            userInteractionCount: a.score,
          },
          {
            '@type': 'InteractionCounter',
            interactionType: 'https://schema.org/CommentAction',
            userInteractionCount: a.commentCount,
          },
        ],
      };
    }

    case 'person': {
      const p = data as JsonLdEntity;
      return {
        ...baseData,
        name: p.displayName || p.name,
        alternateName: p.name,
        description: p.description,
        url: `${SITE_URL}/u/${p.name}`,
      };
    }

    case 'organization': {
      const o = data as JsonLdEntity;
      return {
        ...baseData,
        name: o.displayName || o.name,
        alternateName: `m/${o.name}`,
        description: o.description,
        url: `${SITE_URL}/m/${o.name}`,
        memberOf: {
          '@type': 'Organization',
          name: SITE_NAME,
        },
      };
    }

    default:
      return baseData;
  }
}

// Script component for JSON-LD — uses ref to set textContent safely (no dangerouslySetInnerHTML)
export function JsonLdScript({ data }: { data: object }) {
  const ref = React.useRef<HTMLScriptElement>(null);
  React.useEffect(() => {
    if (ref.current) {
      ref.current.textContent = JSON.stringify(data);
    }
  }, [data]);
  return <script ref={ref} type="application/ld+json" />;
}

// Breadcrumb JSON-LD
export function generateBreadcrumbJsonLd(
  items: { name: string; url: string }[],
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: `${SITE_URL}${item.url}`,
    })),
  };
}

// FAQ JSON-LD
export function generateFaqJsonLd(
  faqs: { question: string; answer: string }[],
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };
}
