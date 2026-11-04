import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT, readJson, writeJson } from "./store.mjs";
import { metrics } from "./metrics.mjs";

const CACHE_DIR = path.join(ROOT, "cache");
const TRANS_DIR = path.join(CACHE_DIR, "translations");
const SOURCE_DIR = path.join(CACHE_DIR, "sources");
const EMBED_DIR = path.join(CACHE_DIR, "embeddings");
const RECOM_DIR = path.join(CACHE_DIR, "recommendations");

// Ensure cache subdirectories exist
for (const dir of [CACHE_DIR, TRANS_DIR, SOURCE_DIR, EMBED_DIR, RECOM_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// In-memory Level 1 caches (LRU-bounded)
class MemoryLru {
  constructor(maxSize = 250) {
    this.maxSize = maxSize;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return null;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(key, val);
  }
  has(key) {
    return this.map.has(key);
  }
  delete(key) {
    return this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const memTrans = new MemoryLru(300);
const memSource = new MemoryLru(200);
const memEmbed = new MemoryLru(500);
const memRecom = new MemoryLru(100);

/**
 * Computes deterministic SHA256 hex hash from string or array of strings.
 */
export function getContentHash(input) {
  const str = Array.isArray(input)
    ? input.map((s) => (typeof s === "string" ? s : s?.zh || s?.text || JSON.stringify(s))).join("\n")
    : String(input || "");
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

/**
 * Deterministic Translation Cache Key Generator
 */
export function buildTranslationKey({
  source = "",
  novel = "",
  chapter = 0,
  contentHash = "",
  sourceLang = "zh",
  targetLang = "en",
  model = "",
  promptVersion = "",
}) {
  const normModel = typeof model === "object" ? model?.id || JSON.stringify(model) : String(model || "");
  const payload = {
    source: String(source).toLowerCase().replace(/\/+$/, ""),
    novel: String(novel),
    chapter: Number(chapter) || 0,
    contentHash: String(contentHash),
    sourceLang,
    targetLang,
    model: normModel,
    promptVersion: String(promptVersion),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Estimate token count for Chinese/English text
 * (Roughly 1.5 characters per token for Chinese, ~4 characters per token for English)
 */
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjkMatches = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkLen = s.length - cjkCount;
  return Math.round(cjkCount * 1.4 + nonCjkLen / 4) + 10;
}

// -------------------------------------------------------------------------
// 1. TRANSLATION CACHE
// -------------------------------------------------------------------------

export function getTranslationCache(key, expectedContentHash = null) {
  // Check L1 Memory
  let hit = memTrans.get(key);
  if (!hit) {
    // Check L2 Disk
    const file = path.join(TRANS_DIR, `${key}.json`);
    hit = readJson(file);
    if (hit) memTrans.set(key, hit);
  }

  if (hit) {
    // Verify content hash integrity if provided
    if (expectedContentHash && hit.contentHash && hit.contentHash !== expectedContentHash) {
      console.log(`[CACHE INVALIDATED: translation] Content hash mismatch for key ${key.slice(0, 8)}`);
      memTrans.delete(key);
      return null;
    }
    metrics.record("translation_cache_hit", 1);
    if (hit.tokensEstimate) {
      metrics.record("tokens_saved", hit.tokensEstimate);
    }
    console.log(`[CACHE HIT: translation] Key ${key.slice(0, 8)} (saved ~${hit.tokensEstimate || 1200} tokens)`);
    return hit;
  }

  metrics.record("translation_cache_miss", 1);
  return null;
}

export function setTranslationCache(key, data) {
  if (!data) return;
  const content = Array.isArray(data.paragraphs)
    ? data.paragraphs.map((p) => p.zh || "").join("\n")
    : "";
  const tokensEstimate = estimateTokens(content) || 1200;

  const record = {
    ...data,
    key,
    tokensEstimate,
    cachedAt: Date.now(),
  };

  memTrans.set(key, record);
  const file = path.join(TRANS_DIR, `${key}.json`);
  writeJson(file, record);
}

// -------------------------------------------------------------------------
// 2. SOURCE CONTENT CACHE
// -------------------------------------------------------------------------

export function buildSourceKey(novelSlug, index, url = "") {
  return crypto
    .createHash("sha256")
    .update(`${novelSlug}:${index}:${url}`)
    .digest("hex");
}

export function getSourceCache(key) {
  let hit = memSource.get(key);
  if (!hit) {
    const file = path.join(SOURCE_DIR, `${key}.json`);
    hit = readJson(file);
    if (hit) memSource.set(key, hit);
  }

  if (hit) {
    metrics.record("source_cache_hit", 1);
    console.log(`[CACHE HIT: source] Key ${key.slice(0, 8)}`);
    return hit;
  }

  metrics.record("source_cache_miss", 1);
  return null;
}

export function setSourceCache(key, data) {
  if (!data) return;
  const contentHash = getContentHash(data.paragraphs || []);
  const record = {
    ...data,
    contentHash,
    cachedAt: Date.now(),
  };
  memSource.set(key, record);
  writeJson(path.join(SOURCE_DIR, `${key}.json`), record);
}

// -------------------------------------------------------------------------
// 3. EMBEDDING CACHE
// -------------------------------------------------------------------------

export function buildEmbeddingKey({ contentHash, model = "default", dimensions = 1536, version = "v1" }) {
  return crypto
    .createHash("sha256")
    .update(`${contentHash}:${model}:${dimensions}:${version}`)
    .digest("hex");
}

export function getEmbeddingCache(key) {
  let hit = memEmbed.get(key);
  if (!hit) {
    hit = readJson(path.join(EMBED_DIR, `${key}.json`));
    if (hit) memEmbed.set(key, hit);
  }

  if (hit) {
    metrics.record("embedding_cache_hit", 1);
    console.log(`[CACHE HIT: embedding] Key ${key.slice(0, 8)}`);
    return hit.vector || hit;
  }

  metrics.record("embedding_cache_miss", 1);
  return null;
}

export function setEmbeddingCache(key, { contentHash, model, dimensions, version, vector }) {
  const record = {
    contentHash,
    model,
    dimensions,
    version,
    vector,
    cachedAt: Date.now(),
  };
  memEmbed.set(key, record);
  writeJson(path.join(EMBED_DIR, `${key}.json`), record);
}

// -------------------------------------------------------------------------
// 4. RECOMMENDATION CACHE
// -------------------------------------------------------------------------

export function getRecommendationCache(slug) {
  let hit = memRecom.get(slug);
  if (!hit) {
    hit = readJson(path.join(RECOM_DIR, `${slug}.json`));
    if (hit) memRecom.set(slug, hit);
  }

  if (hit && Array.isArray(hit.recommendations)) {
    // Invalidate if older than 7 days
    if (Date.now() - (hit.cachedAt || 0) < 7 * 86400 * 1000) {
      metrics.record("recommendation_cache_hit", 1);
      console.log(`[CACHE HIT: recommendations] Novel ${slug.slice(0, 16)}`);
      return hit.recommendations;
    }
  }

  metrics.record("recommendation_cache_miss", 1);
  return null;
}

export function setRecommendationCache(slug, recommendations) {
  const record = {
    slug,
    recommendations,
    cachedAt: Date.now(),
  };
  memRecom.set(slug, record);
  writeJson(path.join(RECOM_DIR, `${slug}.json`), record);
}

// -------------------------------------------------------------------------
// 5. CACHE ADMIN / STATS
// -------------------------------------------------------------------------

export function clearAllCaches() {
  memTrans.clear();
  memSource.clear();
  memEmbed.clear();
  memRecom.clear();
  console.log("Cleared in-memory cache tiers.");
}
