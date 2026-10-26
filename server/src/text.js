export const STOPWORDS = new Set(`a about above after again against all also am an and any are aren't as at be because been before
being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from
further get got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i
i'd i'll i'm i've if in into is isn't it it's its itself just let's like made make many may me might more most much must mustn't my
myself new no nor not now of off on once one only or other ought our ours ourselves out over own said same say says shan't she she'd
she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd
they'll they're they've this those though through to too two under until up upon us use used very via was wasn't we we'd we'll we're
we've were weren't what what's when when's where where's whether which while who who's whom why why's will with won't would wouldn't
year years yet you you'd you'll you're you've your yours yourself yourselves also even still well back way going know think people
time times told according including however per percent since three four five first last next mr mrs ms dr according around another
among within without across already really s t don re ve ll d m http https www com html amp nbsp`.split(/\s+/));

export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function normalize(text) {
  return stripHtml(text).replace(/\s+/g, ' ').trim();
}

export function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function splitSentences(text) {
  const parts = String(text || '').match(/[^.!?\n]+[.!?]*/g) || [];
  return parts.map((s) => s.trim()).filter((s) => s.length > 2);
}

/** Splits text into chunks of at most `size` characters, breaking on sentence boundaries where possible. */
export function chunkText(text, size, maxChunks) {
  const chunks = [];
  let current = '';
  for (const sentence of splitSentences(text)) {
    if ((current + ' ' + sentence).length > size && current) {
      chunks.push(current.trim());
      current = '';
      if (chunks.length >= maxChunks) return chunks;
    }
    current += ' ' + (sentence.length > size ? sentence.slice(0, size) : sentence);
  }
  if (current.trim() && chunks.length < maxChunks) chunks.push(current.trim());
  return chunks.length ? chunks : [String(text || '').slice(0, size)];
}

export function tokenize(text) {
  const tokens = String(text || '').toLowerCase().match(/[a-z][a-z'-]+/g) || [];
  return tokens
    .map((t) => t.replace(/^['-]+|['-]+$/g, '').replace(/'s$/, ''))
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function clamp(x, lo = 0, hi = 1) {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));
