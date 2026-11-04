import { cacheGet, cacheKey, cachePut } from "./store.mjs";

const GTX_URL = "https://translate.googleapis.com/translate_a/single";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DELIMITER = " ||| ";
const MAX_BATCH_CHARS = 3200;
const MAX_CHUNK_ITEMS = 35;
const TIMEOUT_MS = 10000;
const MAX_LRU_SIZE = 4000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Fast in-memory LRU cache
const memoryCache = new Map();

// In-flight Promise deduplication map
const inFlightRequests = new Map();

// Concurrency limiter (max 3 concurrent outbound requests to Google)
const MAX_CONCURRENT = 3;
let activeRequests = 0;
const waitQueue = [];

function acquireSlot() {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseSlot() {
  activeRequests--;
  if (waitQueue.length > 0 && activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    const next = waitQueue.shift();
    next();
  }
}

/**
 * Retrieve cached translation from memory or persistent disk cache.
 */
export function getFromCache(text, from = "auto", to = "en") {
  if (!text) return null;
  const memKey = `${from}:${to}:${text}`;
  const hit = memoryCache.get(memKey);
  if (hit) {
    if (Date.now() - hit.timestamp < CACHE_TTL_MS) {
      // Refresh LRU order
      memoryCache.delete(memKey);
      memoryCache.set(memKey, hit);
      return hit.val;
    }
    memoryCache.delete(memKey);
  }

  // Fallback to disk cache
  try {
    const diskKey = cacheKey({ v: "gtx-v1", from, to, text });
    const diskHit = cacheGet(diskKey);
    if (diskHit && typeof diskHit === "string") {
      memoryCache.set(memKey, { val: diskHit, timestamp: Date.now() });
      return diskHit;
    }
  } catch {}
  return null;
}

/**
 * Save translation to memory LRU cache and persistent disk cache.
 */
export function saveToCache(text, translation, from = "auto", to = "en") {
  if (!text || !translation) return;
  const memKey = `${from}:${to}:${text}`;
  if (memoryCache.size >= MAX_LRU_SIZE) {
    const firstKey = memoryCache.keys().next().value;
    if (firstKey) memoryCache.delete(firstKey);
  }
  memoryCache.set(memKey, { val: translation, timestamp: Date.now() });

  try {
    const diskKey = cacheKey({ v: "gtx-v1", from, to, text });
    cachePut(diskKey, translation);
  } catch {}
}

/**
 * Execute raw GTX HTTP POST request with AbortSignal, retry on 429/5xx, and response parsing.
 */
async function callGtxApi(q, from = "auto", to = "en", retryCount = 0) {
  await acquireSlot();
  try {
    const params = new URLSearchParams({
      client: "gtx",
      dt: "t",
      sl: from,
      tl: to,
      q,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("GTX request timeout")), TIMEOUT_MS);

    try {
      const res = await fetch(GTX_URL, {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "*/*",
        },
        body: params.toString(),
        signal: controller.signal,
      });

      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && retryCount < 1) {
          await new Promise((r) => setTimeout(r, 400));
          return await callGtxApi(q, from, to, retryCount + 1);
        }
        throw new Error(`GTX HTTP ${res.status}: ${res.statusText}`);
      }

      const j = await res.json();
      const segs = Array.isArray(j?.[0]) ? j[0] : [];
      const out = segs.map((s) => (Array.isArray(s) ? s[0] || "" : "")).join("");
      return out;
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    releaseSlot();
  }
}

/**
 * Translate a single text string using Google GTX with memory/disk caching and in-flight deduplication.
 */
export async function gtxTranslate(text, { from = "auto", to = "en" } = {}) {
  if (!text || typeof text !== "string") return "";
  const cleaned = text.trim();
  if (!cleaned) return "";

  // Skip translation if target is English and text has no Chinese / Asian characters
  const isTargetEn = to.toLowerCase().startsWith("en");
  if (isTargetEn && !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(cleaned)) {
    return cleaned;
  }
  // Skip translation if target is Chinese and text is already pure Chinese
  const isTargetZh = to.toLowerCase().startsWith("zh");
  if (isTargetZh && /[\u4e00-\u9fff]/.test(cleaned) && !/[a-zA-Z]{3,}/.test(cleaned)) {
    return cleaned;
  }

  // Cache hit check
  const cached = getFromCache(cleaned, from, to);
  if (cached) return cached;

  const dedupKey = `single:${from}:${to}:${cleaned}`;
  let req = inFlightRequests.get(dedupKey);
  if (!req) {
    req = callGtxApi(cleaned, from, to)
      .then((out) => {
        const val = String(out || "").trim();
        if (val) saveToCache(cleaned, val, from, to);
        return val || cleaned;
      })
      .finally(() => inFlightRequests.delete(dedupKey));
    inFlightRequests.set(dedupKey, req);
  }

  return await req;
}

/**
 * Batch translate an array of texts using Google GTX.
 * Respects batching limits (chunks up to 35 items / 3200 characters in 1 single HTTP request)
 * and leverages cache + deduplication to never exploit or spam the upstream API.
 */
export async function gtxTranslateBatch(texts, { from = "auto", to = "en" } = {}) {
  if (!Array.isArray(texts) || !texts.length) return [];

  const results = new Array(texts.length).fill(null);
  const uncached = [];

  // 1. Pre-validation and cache resolution
  texts.forEach((original, idx) => {
    const text = String(original || "").trim();
    if (!text) {
      results[idx] = "";
      return;
    }
    const isTargetEn = to.toLowerCase().startsWith("en");
    if (isTargetEn && !/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text)) {
      results[idx] = text;
      return;
    }
    const isTargetZh = to.toLowerCase().startsWith("zh");
    if (isTargetZh && /[\u4e00-\u9fff]/.test(text) && !/[a-zA-Z]{3,}/.test(text)) {
      results[idx] = text;
      return;
    }
    const cached = getFromCache(text, from, to);
    if (cached) {
      results[idx] = cached;
    } else {
      uncached.push({ idx, text });
    }
  });

  if (!uncached.length) return results;

  // 2. Partition uncached items into size-bounded batch chunks
  const chunks = [];
  let currentChunk = [];
  let currentLen = 0;

  for (const item of uncached) {
    const sanitizedText = item.text.replace(/\|+/g, "-");
    const itemLen = sanitizedText.length + DELIMITER.length;

    if (
      currentChunk.length >= MAX_CHUNK_ITEMS ||
      (currentLen + itemLen > MAX_BATCH_CHARS && currentChunk.length > 0)
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLen = 0;
    }

    currentChunk.push({ ...item, sanitized: sanitizedText });
    currentLen += itemLen;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  // 3. Process batch chunks with in-flight deduplication
  for (const chunk of chunks) {
    if (chunk.length === 1) {
      // Single item chunk
      try {
        const tr = await gtxTranslate(chunk[0].text, { from, to });
        results[chunk[0].idx] = tr;
      } catch (err) {
        results[chunk[0].idx] = chunk[0].text;
      }
      continue;
    }

    const payload = chunk.map((c) => c.sanitized).join(DELIMITER);
    const dedupKey = `batch:${from}:${to}:${payload}`;

    let req = inFlightRequests.get(dedupKey);
    if (!req) {
      req = (async () => {
        try {
          const rawOut = await callGtxApi(payload, from, to);
          const parts = String(rawOut || "").split(/\s*\|\|\|\s*/);

          if (parts.length === chunk.length) {
            chunk.forEach((c, i) => {
              const val = parts[i].trim();
              if (val) {
                results[c.idx] = val;
                saveToCache(c.text, val, from, to);
              } else {
                results[c.idx] = c.text;
              }
            });
            return;
          }

          // If delimiter count mismatch occurred, translate chunk items individually via queue
          for (const c of chunk) {
            try {
              const sOut = await callGtxApi(c.sanitized, from, to);
              const sVal = String(sOut || "").trim();
              results[c.idx] = sVal || c.text;
              if (sVal) saveToCache(c.text, sVal, from, to);
            } catch {
              results[c.idx] = c.text;
            }
          }
        } catch (err) {
          // If chunk failed, fallback to original texts
          chunk.forEach((c) => {
            if (results[c.idx] === null) results[c.idx] = c.text;
          });
        }
      })().finally(() => inFlightRequests.delete(dedupKey));

      inFlightRequests.set(dedupKey, req);
    }

    await req;
  }

  // 4. Fill any remaining unassigned entries
  return results.map((r, i) => r ?? texts[i]);
}
