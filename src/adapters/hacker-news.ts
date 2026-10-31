import { z } from 'zod';
import type { CandidateStory, HackerNewsAdapter } from '../types.ts';

const searchPage = z.object({
  hits: z.array(z.object({
    objectID: z.string().min(1),
    title: z.string().nullable(),
    url: z.string().nullish(),
    story_text: z.string().nullish(),
    points: z.number().nullable(),
    created_at_i: z.number().int().nonnegative(),
  })),
  nbPages: z.number().int().nonnegative(),
  nbHits: z.number().int().nonnegative().optional(),
});

export function createHackerNewsAdapter(options: { fetch?: typeof fetch } = {}): HackerNewsAdapter {
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async discover({ since, until, minScore }) {
      const stories = new Map<string, CandidateStory>();
      const start = Math.floor(Date.parse(since) / 1000);
      const end = Math.floor(Date.parse(until) / 1000);
      let pages = 1;
      for (let page = 0; page < pages; page++) {
        const url = new URL('https://hn.algolia.com/api/v1/search_by_date');
        url.search = new URLSearchParams({
          tags: 'story',
          numericFilters: `points>=${minScore},created_at_i>=${start},created_at_i<=${end}`,
          hitsPerPage: '100',
          page: String(page),
        }).toString();
        const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`Hacker News request failed (HTTP ${response.status})`);
        const data = searchPage.parse(await response.json());
        pages = data.nbPages;
        if (data.nbHits !== undefined && data.nbHits > pages * 100) {
          throw new Error('Hacker News search window exceeds the available result pages');
        }
        for (const hit of data.hits) {
          if (!hit.title || hit.points === null || hit.points < minScore || hit.created_at_i < start || hit.created_at_i > end) continue;
          const articleUrl = safeHttpUrl(hit.url);
          stories.set(hit.objectID, {
            id: hit.objectID,
            title: hit.title,
            ...(articleUrl ? { url: articleUrl } : {}),
            hnUrl: `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`,
            ...(hit.story_text ? { text: hit.story_text } : {}),
            score: hit.points,
            publishedAt: new Date(hit.created_at_i * 1000).toISOString(),
          });
        }
      }
      return [...stories.values()];
    },
  };
}

function safeHttpUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch {
    // HN text-only or malformed source links still retain their discussion URL.
  }
  return undefined;
}
