/**
 * Die URLs, unter denen die Content-API Bilder ausliefert (AP3.T3.5).
 *
 * An einer Stelle, damit sie im Vertrag und im Router nicht auseinanderlaufen.
 */

/** Auth-geschützter Bildabruf für ein Buch-Asset. */
export function assetImageUrl(assetId: string): string {
  return `/api/content/assets/${assetId}/image`;
}
