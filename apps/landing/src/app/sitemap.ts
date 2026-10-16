import type { MetadataRoute } from 'next';
import { getSiteUrl } from '@/lib/seo';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: getSiteUrl().toString(),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
