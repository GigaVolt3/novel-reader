import { cacheGet, cacheKey, cachePut, loadConfig } from "./store.mjs";
import { getContentHash, buildTranslationKey, getTranslationCache, setTranslationCache } from "./cache.mjs";
import { gtxTranslate, gtxTranslateBatch } from "./gtx.mjs";
import * as openrouter from "./openrouter.mjs";
import * as groq from "./groq.mjs";

const PROMPT_VERSION = "zh-en-v4-effects";

const STYLE_RULES = `You are an elite literary translator specializing in Chinese web novels (cultivation, xianxia, system/litRPG, historical, transmigration).
Translate the Chinese paragraphs into vivid, immersive, and expressive English.

Stylistic & Effect Formatting Rules:
1. System & LitRPG Notifications:
   - For all game/system announcements, ding sounds (叮！), quest alerts, reward prompts, and stat windows, use brackets:
     e.g., 【Ding! System loading complete!】
     e.g., 【System Notification: Congratulations, Host, on obtaining one [Marrow-Washing Pill]!】
     e.g., 【Status Panel: Cultivation: Third-Rate Warrior | Technique: [True Dragon Art]】
2. Anger, Shouting, and Booming Commands:
   - When a character is shouting in fury, roaring, barking commands, or speaking with intense emotion or divine pressure, format the spoken words in bold:
     e.g., **"Silence!"**, **"Die!"**, **"Insolent fool, how dare you!"**
3. Sound Effects & Combat Impact:
   - Put sound effects (onomatopoeia) in italics:
     e.g., *Boom!*, *Clang!*, *Whoosh!*, *Swish!*, *Rumble!*, *Crack!*, *Thud!*
4. Internal Monologue & Thoughts:
   - Format internal thoughts in italics or single quotes:
     e.g., *Wait, did I really transmigrate?!* or 'This Crown Prince is scheming...'
5. Named Techniques, Artifacts & Pills:
   - Capitalize and wrap heavenly treasures, divine arts, cultivation realms, and special items in brackets or emphasis:
     e.g., [True Dragon Art of Yanhuang], [Marrow-Washing Pill], [Sky-Piercing Axe].
6. Core Rules:
   - Preserve meaning, tone, and pacing. Never add extraneous commentary or summarize.
   - Keep the exact same number of paragraphs. Do not merge or split paragraphs.
   - Use the glossary exactly as given for names, places, and special terms.
   - Translate idioms and cultivator/jianghu jargon into their natural English sense.
   - Keep dialogue punctuation natural for English.
   - No translator notes, no romanization unless the glossary provides it.
   - Output ONLY a JSON array of English strings: one string per input paragraph, same order, same count.`;

function glossaryFor(texts, glossary) {
  const terms = glossary?.terms ?? [];
  const joined = texts.join("\n");
  const relevant = terms.filter((t) => t?.zh && joined.includes(t.zh));
  // Use only relevant terms; if none match, fall back to top 20 by index (not all 80)
  const chosen = relevant.length ? relevant.slice(0, 30) : terms.slice(0, 20);
  if (!chosen.length) return "(none)";
  return chosen.map((t) => `${t.zh} = ${t.en}${t.note ? ` (${t.note})` : ""}`).join("\n");
}

function buildPrompt({ texts, glossary, context }) {
  const contextBlock = context?.length
    ? `\nPrevious paragraphs, for continuity only (do not translate, do not repeat):\n${context
        .map((t) => `- ${t}`)
        .join("\n")}\n`
    : "";
  return `${STYLE_RULES}

Glossary:
${glossaryFor(texts, glossary)}
${contextBlock}
Input paragraphs (JSON array of ${texts.length} Chinese paragraphs):
${JSON.stringify(texts)}

Return a JSON array of exactly ${texts.length} English strings.`;
}

export function cleanTranslation(text) {
  if (!text) return "";
  let s = String(text).trim();

  // 1. Remove thinking / reasoning tags
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<thought>[\s\S]*?<\/thought>/gi, "");

  // 2. Remove AI reasoning preamble / scratchpads
  // e.g. "The user wants translation of Chinese paragraph into natural English..."
  // e.g. "We need to translate... Let's translate:"
  // e.g. "Interpretation: ... Maybe: ..."
  // e.g. "Here is the translation:"
  s = s.replace(
    /^(?:the user wants|we need to translate|let'?s translate|let'?s parse|interpretation:|translating this|here is (?:the|a) translation|translation\s*[:：])[\s\S]*?(?:(?:here is (?:the|a) translation|translation\s*[:：]|let'?s translate[^\n]*)\s*[:：]?\n+|\n\n+)/i,
    ""
  );

  // If the entire output starts with "The user wants..." or "Let's translate..."
  if (/^(?:the user wants|we need to translate|let'?s translate|let'?s parse)/i.test(s)) {
    const parts = s.split(/\n\s*\n+/);
    const validPart = parts.reverse().find(
      (p) =>
        p.trim() &&
        !/^(?:the user wants|we need to|let'?s|interpretation:|chinese\s*[:：]|maybe\s*[:：]|parsing)/i.test(p.trim())
    );
    if (validPart) s = validPart;
  }

  // Remove conversational prefaces
  s = s.replace(/^here(?:'s| is) (?:the |a )?(?:natural )?(?:english )?translation\s*[:：]?\s*/i, "");
  s = s.replace(/^translation\s*[:：]\s*/i, "");

  // Remove leading/trailing markdown code blocks if any
  s = s.replace(/^```(?:json|markdown)?\s*/i, "").replace(/```\s*$/i, "");

  // Remove surrounding stray quotes
  s = s.replace(/^["'“”`]|["'“”`]$/g, "").trim();

  return s;
}

function parseJsonArray(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseArray(raw) {
  const value = parseJsonArray(raw);
  if (!value) return null;
  return value.map((v) => cleanTranslation(typeof v === "string" ? v : String(v ?? "")));
}

function batches(paragraphs, maxChars = 1500, maxItems = 20) {
  const out = [];
  let current = [];
  let size = 0;
  for (const p of paragraphs) {
    const chars = p.text.length;
    if (current.length && (size + chars > maxChars || current.length >= maxItems)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += chars;
  }
  if (current.length) out.push(current);
  return out;
}

function checkIsGroq(model) {
  if (!model) return false;
  if (typeof model === "object") return model.providerID === "groq";
  if (typeof model === "string") {
    return model.startsWith("groq/") || model.startsWith("qwen/") || model.startsWith("openai/gpt-oss");
  }
  return false;
}

function isFatalAuthError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("invalid api key") || msg.includes("401");
}

export async function doGenerate({ prompt, model, apiKey }) {
  const isGroq = checkIsGroq(model);
  if (isGroq) {
    try {
      return await groq.generate(prompt, { model, apiKey });
    } catch (err) {
      if (openrouter.isAvailable() && !isFatalAuthError(err)) {
        console.warn(`⚡ Provider Failover: Groq exhausted (${err.message}). Seamlessly failing over to OpenRouter...`);
        return await openrouter.generate(prompt, { apiKey });
      }
      throw err;
    }
  } else {
    try {
      return await openrouter.generate(prompt, { model, apiKey });
    } catch (err) {
      if (groq.isAvailable() && !isFatalAuthError(err)) {
        console.warn(`⚡ Provider Failover: OpenRouter exhausted (${err.message}). Seamlessly failing over to Groq...`);
        return await groq.generate(prompt, { apiKey });
      }
      throw err;
    }
  }
}

async function translateBatch({ items, glossary, context, model, apiKey }) {
  const texts = items.map((i) => i.text);
  const batchHash = getContentHash(texts);
  const key = buildTranslationKey({
    novel: "batch",
    chapter: 0,
    contentHash: batchHash,
    model: model?.id || model,
    promptVersion: PROMPT_VERSION,
  });

  const cached = getTranslationCache(key, batchHash);
  if (cached?.paragraphs?.length === texts.length) {
    return cached.paragraphs.map((p) => p.en);
  }

  let result = null;
  let prompt = buildPrompt({ texts, glossary, context });
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    const raw = await doGenerate({ prompt, model, apiKey });
    const parsed = parseArray(raw);
    if (parsed && parsed.length === texts.length && parsed.every((s) => s.length > 0)) {
      result = parsed;
      break;
    }
    prompt = `${buildPrompt({ texts, glossary, context })}

Your previous reply did not contain exactly ${texts.length} strings. Reply with the JSON array only.`;
  }

  if (!result) {
    // last resort: one paragraph at a time, strictly requesting a JSON array of 1 item
    result = [];
    for (const text of texts) {
      const singlePrompt = `${STYLE_RULES}

Glossary:
${glossaryFor([text], glossary)}

Translate this single Chinese paragraph into natural English.
Output ONLY a JSON array with exactly 1 string: ["English translation"].

Input:
${JSON.stringify([text])}`;

      let translatedStr = "";
      try {
        const raw = await doGenerate({ prompt: singlePrompt, model, apiKey });
        const arr = parseArray(raw);
        if (arr && arr[0]) {
          translatedStr = arr[0];
        } else {
          translatedStr = cleanTranslation(raw);
        }
      } catch (err) {
        console.warn("Single paragraph fallback failed:", err.message);
      }
      result.push(cleanTranslation(translatedStr));
    }
  }

  setTranslationCache(key, {
    contentHash: batchHash,
    paragraphs: result.map((en, idx) => ({ zh: texts[idx], en })),
  });
  return result;
}

function isFatalError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("free-models-per-day") ||
    msg.includes("credits") ||
    msg.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("key is missing") ||
    msg.includes("service unavailable")
  );
}

async function translateGroup({ items, glossary, context, model, apiKey, depth = 0 }) {
  try {
    return await translateBatch({ items, glossary, context, model, apiKey });
  } catch (err) {
    // If it's a hard API rate limit, quota exhaustion, or auth error, fail immediately — do not subdivide!
    if (isFatalError(err) || items.length === 1 || depth >= 3) throw err;
    const mid = Math.ceil(items.length / 2);
    const left = await translateGroup({
      items: items.slice(0, mid),
      glossary,
      context,
      model,
      apiKey,
      depth: depth + 1,
    });
    const right = await translateGroup({
      items: items.slice(mid),
      glossary,
      context: left.slice(-2),
      model,
      apiKey,
      depth: depth + 1,
    });
    return [...left, ...right];
  }
}

export function zhNumToInt(str) {
  const map = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (!str) return 0;
  if (/^\d+$/.test(str)) return parseInt(str, 10);
  let total = 0, section = 0;
  for (const char of str) {
    if (map[char] !== undefined) section = map[char];
    else if (char === '十') { total += (section || 1) * 10; section = 0; }
    else if (char === '百') { total += section * 100; section = 0; }
    else if (char === '千') { total += section * 1000; section = 0; }
    else if (char === '万') { total = (total + section) * 10000; section = 0; }
  }
  return total + section;
}

export function formatChapterTitleRule(title) {
  if (!title || typeof title !== "string") return "";
  const cleaned = title.trim();
  const m = cleaned.match(/^第\s*([0-9零一二三四五六七八九十百千万两〇]+)\s*[章节回卷话集篇][:：\s]*(.*)$/);
  if (m) {
    const num = zhNumToInt(m[1]);
    const rest = m[2].trim();
    return rest ? `Chapter ${num}: ${rest}` : `Chapter ${num}`;
  }
  if (/^楔子/i.test(cleaned)) return cleaned.replace(/^楔子[:：\s]*/, "Prologue: ");
  if (/^尾声/i.test(cleaned)) return cleaned.replace(/^尾声[:：\s]*/, "Epilogue: ");
  if (/^番外/i.test(cleaned)) return cleaned.replace(/^番外[:：\s]*/, "Extra: ");
  if (/^大结局/i.test(cleaned)) return cleaned.replace(/^大结局[:：\s]*/, "Grand Finale: ");
  return cleaned;
}

export async function translateTitleBatch(titles, { model, apiKey, type = "chapter" } = {}) {
  if (!Array.isArray(titles) || !titles.length) return [];

  const cleaned = titles.map((t) =>
    (t || "")
      .replace(/\s*(最新章节|全文阅读|免费阅读|无弹窗|txt下载|列表|目录)\s*$/gi, "")
      .replace(/^["'“”]|["'“”]$/g, "")
      .trim()
  );

  // 1. Ultra-fast path: Google GTX batch translation (chunks of titles in 1 single HTTP request)
  try {
    const gtxResults = await gtxTranslateBatch(cleaned);
    if (Array.isArray(gtxResults) && gtxResults.length === cleaned.length) {
      const anyTranslated = gtxResults.some((r, i) => r && r !== cleaned[i] && !/[\u4e00-\u9fff]/.test(r));
      if (anyTranslated) {
        return gtxResults.map((res, i) => {
          if (res && res !== cleaned[i] && !/[\u4e00-\u9fff]/.test(res)) {
            const key = cacheKey({ v: "title-v1", type, text: cleaned[i] });
            cachePut(key, res);
            return res;
          }
          return type === "novel" ? titles[i] : formatChapterTitleRule(titles[i]);
        });
      }
    }
  } catch (err) {
    console.warn("GTX batch title translation failed, falling back to LLM:", err.message);
  }

  // 2. Fallback path: LLM batch translation if GTX was unavailable
  const effectiveModel = model || loadConfig().model;
  const results = new Array(titles.length).fill(null);
  const toFetch = [];
  cleaned.forEach((t, i) => {
    if (!t) {
      results[i] = "";
      return;
    }
    const key = cacheKey({ v: "title-v1", type, text: t });
    const cached = cacheGet(key);
    if (cached && typeof cached === "string") {
      results[i] = cached;
    } else {
      toFetch.push({ index: i, text: t });
    }
  });

  if (!toFetch.length) return results;

  // Batch in chunks of up to 40 titles per single API call
  const CHUNK_SIZE = 40;
  for (let c = 0; c < toFetch.length; c += CHUNK_SIZE) {
    const chunk = toFetch.slice(c, c + CHUNK_SIZE);
    const chunkTexts = chunk.map((item) => item.text);

    const prompt =
      type === "novel"
        ? `Translate this JSON array of Chinese novel/book titles into natural English. Do NOT add chapter numbers. Return ONLY a JSON array of ${chunkTexts.length} English strings in the same order.\n\nInput:\n${JSON.stringify(chunkTexts)}`
        : `Translate this JSON array of Chinese chapter titles into natural English. Keep the chapter number format (e.g. "Chapter 1: ..."). Return ONLY a JSON array of ${chunkTexts.length} English strings in the same order.\n\nInput:\n${JSON.stringify(chunkTexts)}`;

    try {
      const raw = await doGenerate({ prompt, model: effectiveModel, apiKey });
      const parsed = parseArray(raw);
      if (Array.isArray(parsed) && parsed.length === chunkTexts.length) {
        chunk.forEach((item, idx) => {
          const val = String(parsed[idx] || "").replace(/^["'“”]|["'“”]$/g, "").trim();
          if (val) {
            results[item.index] = val;
            const key = cacheKey({ v: "title-v1", type, text: item.text });
            cachePut(key, val);
          }
        });
      }
    } catch (err) {
      console.warn("Batch title translation failed:", err.message);
    }
  }

  // Fill any remaining with instant rule-based formatted titles
  return results.map((res, i) => res || (type === "novel" ? titles[i] : formatChapterTitleRule(titles[i])));
}

export async function translateTitle(text, type = "novel", { model, apiKey } = {}) {
  if (!text || typeof text !== "string") return "";
  const cleaned = text
    .replace(/\s*(最新章节|全文阅读|免费阅读|无弹窗|txt下载|列表|目录)\s*$/gi, "")
    .replace(/^["'“”]|["'“”]$/g, "")
    .trim();
  if (!cleaned) return "";

  // Check cache
  const key = cacheKey({ v: "title-v1", type, text: cleaned });
  const cached = cacheGet(key);
  if (cached && typeof cached === "string") return cached;

  // 1. Fast path: Google GTX translate
  try {
    const gtxRes = await gtxTranslate(cleaned);
    const res = String(gtxRes || "").trim();
    if (res && res !== cleaned && !/[\u4e00-\u9fff]/.test(res)) {
      cachePut(key, res);
      return res;
    }
  } catch (err) {
    console.warn(`GTX translate title "${cleaned}" failed, falling back to LLM:`, err.message);
  }

  // 2. Fallback path: LLM translation
  const effectiveModel = model || loadConfig().model;
  const prompt =
    type === "chapter"
      ? `Translate this Chinese chapter title into natural English. Keep the chapter number format (e.g. "Chapter 1: ..."). Output ONLY the English translation, no quotes, no explanation:\n\n${cleaned}`
      : `Translate this Chinese web novel title into a natural, catchy English book title. Output ONLY the English title, no quotes, no explanation:\n\n${cleaned}`;

  try {
    const raw = await doGenerate({ prompt, model: effectiveModel, apiKey });
    let res = String(raw || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^title\s*[:：]\s*/i, "")
      .replace(/^translation\s*[:：]\s*/i, "")
      .replace(/^["'“”]|["'“”]$/g, "")
      .trim();
    res = res.replace(/^\[\s*"/, "").replace(/"\s*\]$/, "").trim();
    if (res && res !== cleaned) {
      cachePut(key, res);
      return res;
    }
  } catch (err) {
    console.warn(`Failed to translate ${type} title "${cleaned}":`, err.message);
  }
  return formatChapterTitleRule(text);
}

export async function translateDescription(text, { model, apiKey } = {}) {
  if (!text || typeof text !== "string") return "";
  const cleaned = text.trim();
  if (!cleaned) return "";

  // Check cache
  const key = cacheKey({ v: "desc-v1", text: cleaned });
  const cached = cacheGet(key);
  if (cached && typeof cached === "string") return cached;

  // 1. Fast path: Google GTX translate
  try {
    const gtxRes = await gtxTranslate(cleaned);
    const res = String(gtxRes || "").trim();
    if (res && res !== cleaned && !/[\u4e00-\u9fff]/.test(res)) {
      cachePut(key, res);
      return res;
    }
  } catch (err) {
    console.warn("GTX description translation failed, falling back to LLM:", err.message);
  }

  // 2. Fallback path: LLM translation
  const effectiveModel = model || loadConfig().model;
  const prompt = `Translate the following Chinese novel synopsis into clear, engaging, fluent English. Return ONLY the translated English text with no quotes, commentary, or reasoning.\n\nSynopsis:\n${cleaned}`;

  try {
    const raw = await doGenerate({ prompt, model: effectiveModel, apiKey });
    let res = String(raw || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^synopsis\s*[:：]\s*/i, "")
      .replace(/^translation\s*[:：]\s*/i, "")
      .replace(/^["'“”]|["'“”]$/g, "")
      .trim();
    if (res && res !== cleaned) {
      cachePut(key, res);
      return res;
    }
  } catch (err) {
    console.warn("Description translation failed:", err.message);
  }
  return cleaned;
}

export async function translateSynopsisBatch(synopses, { model, apiKey } = {}) {
  if (!Array.isArray(synopses) || !synopses.length) return [];

  const cleaned = synopses.map((s) => String(s || "").trim());

  // 1. Ultra-fast path: Google GTX batch translation (chunks of synopses in 1 single HTTP request)
  try {
    const gtxResults = await gtxTranslateBatch(cleaned);
    if (Array.isArray(gtxResults) && gtxResults.length === cleaned.length) {
      const anyTranslated = gtxResults.some((r, i) => r && r !== cleaned[i] && !/[\u4e00-\u9fff]/.test(r));
      if (anyTranslated) {
        return gtxResults.map((res, i) => {
          if (res && res !== cleaned[i] && !/[\u4e00-\u9fff]/.test(res)) {
            const key = cacheKey({ v: "desc-v1", text: cleaned[i] });
            cachePut(key, res);
            return res;
          }
          return synopses[i];
        });
      }
    }
  } catch (err) {
    console.warn("GTX batch synopsis translation failed, falling back to LLM:", err.message);
  }

  // 2. Fallback path: LLM batch translation
  const effectiveModel = model || loadConfig().model;
  const results = new Array(synopses.length).fill(null);
  const toFetch = [];

  synopses.forEach((s, i) => {
    const itemClean = String(s || "").trim();
    if (!itemClean) {
      results[i] = "";
      return;
    }
    const key = cacheKey({ v: "desc-v1", text: itemClean });
    const cached = cacheGet(key);
    if (cached && typeof cached === "string") {
      results[i] = cached;
    } else {
      toFetch.push({ index: i, text: itemClean });
    }
  });

  if (!toFetch.length) return results;

  // Batch in chunks of up to 6 synopses per API call
  const CHUNK_SIZE = 6;
  for (let c = 0; c < toFetch.length; c += CHUNK_SIZE) {
    const chunk = toFetch.slice(c, c + CHUNK_SIZE);
    const chunkTexts = chunk.map((item) => item.text.slice(0, 160));

    const prompt = `Translate this JSON array of Chinese novel synopsis snippets into concise, engaging English (1-2 sentences each). Return ONLY a JSON array of ${chunkTexts.length} English strings in the same order.\n\nInput:\n${JSON.stringify(chunkTexts)}`;

    try {
      const raw = await doGenerate({ prompt, model: effectiveModel, apiKey });
      const parsed = parseArray(raw);
      if (Array.isArray(parsed) && parsed.length === chunkTexts.length) {
        chunk.forEach((item, idx) => {
          const val = String(parsed[idx] || "").replace(/^["'“”]|["'“”]$/g, "").trim();
          if (val) {
            results[item.index] = val;
            const key = cacheKey({ v: "desc-v1", text: item.text });
            cachePut(key, val);
          }
        });
      }
    } catch (err) {
      console.warn("Batch synopsis translation failed:", err.message);
    }
  }

  return results.map((res, i) => res || synopses[i]);
}

export async function translateChapterWithGtx({ chapter, onProgress, shouldAbort = null, isFallback = true }) {
  const contentHash = getContentHash(chapter.paragraphs.map((p) => p.zh || ""));

  // 1. Translate title if Chinese
  const titleNeedsTranslation = !chapter.titleEn || /[\u4e00-\u9fff]/.test(chapter.titleEn);
  if (titleNeedsTranslation && chapter.title) {
    try {
      const transTitle = await gtxTranslate(chapter.title);
      if (transTitle && !/[\u4e00-\u9fff]/.test(transTitle)) {
        chapter.titleEn = transTitle;
      } else {
        chapter.titleEn = formatChapterTitleRule(chapter.title);
      }
    } catch {
      chapter.titleEn = formatChapterTitleRule(chapter.title);
    }
  }

  // 2. Identify paragraphs needing translation
  const pending = chapter.paragraphs
    .map((p, index) => ({ index, text: p.zh, done: Boolean(p.en) }))
    .filter((p) => !p.done && p.text);

  if (!pending.length) {
    chapter.status = "done";
    chapter.isGtxFallback = isFallback;
    chapter.translationProvider = "google-gtx";
    return chapter;
  }

  // 3. Batch into chunks of up to 25 paragraphs using gtxTranslateBatch
  const CHUNK_SIZE = 25;
  const chunks = [];
  for (let i = 0; i < pending.length; i += CHUNK_SIZE) {
    chunks.push(pending.slice(i, i + CHUNK_SIZE));
  }

  let completedBatches = 0;
  for (const chunk of chunks) {
    if (shouldAbort?.()) break;
    const texts = chunk.map((c) => c.text);
    try {
      const trans = await gtxTranslateBatch(texts, { from: "auto", to: "en" });
      chunk.forEach((item, idx) => {
        if (trans[idx]) {
          chapter.paragraphs[item.index].en = trans[idx];
        }
      });
    } catch (err) {
      console.warn("GTX batch translation failed, falling back to sequential:", err.message);
      for (const item of chunk) {
        if (shouldAbort?.()) break;
        try {
          const s = await gtxTranslate(item.text);
          if (s) chapter.paragraphs[item.index].en = s;
        } catch {}
      }
    }
    completedBatches++;
    onProgress?.({
      done: completedBatches,
      total: chunks.length,
      paragraphsDone: chapter.paragraphs.filter((p) => p.en).length,
      paragraphsTotal: chapter.paragraphs.length,
    });
  }

  if (!chapter.titleEn) chapter.titleEn = formatChapterTitleRule(chapter.title);
  chapter.contentHash = contentHash;
  chapter.status = "done";
  chapter.isGtxFallback = isFallback;
  chapter.translationProvider = "google-gtx";
  return chapter;
}

export async function translateChapter({ chapter, glossary, model, batchChars, onProgress, apiKey, shouldAbort = null, force = false }) {
  const contentHash = getContentHash(chapter.paragraphs.map((p) => p.zh || ""));
  const modelId = typeof model === "object" ? model?.id || "auto" : String(model || "auto");
  const chapterCacheKey = buildTranslationKey({
    source: chapter.url || "",
    novel: chapter.slug || "",
    chapter: chapter.index || 0,
    contentHash,
    sourceLang: "zh",
    targetLang: "en",
    model: modelId,
    promptVersion: PROMPT_VERSION,
  });

  // 1. Check persistent chapter translation cache (Deterministic, Cache-First) unless force
  if (!force) {
    const cachedChapter = getTranslationCache(chapterCacheKey, contentHash);
    if (
      cachedChapter &&
      Array.isArray(cachedChapter.paragraphs) &&
      cachedChapter.paragraphs.length === chapter.paragraphs.length &&
      cachedChapter.paragraphs.every((p) => p.en)
    ) {
      chapter.paragraphs = cachedChapter.paragraphs.map((p, idx) => ({
        zh: chapter.paragraphs[idx]?.zh || p.zh,
        en: p.en,
      }));
      if (cachedChapter.titleEn) chapter.titleEn = cachedChapter.titleEn;
      chapter.contentHash = contentHash;
      chapter.status = "done";
      chapter.isGtxFallback = false;
      chapter.translationProvider = checkIsGroq(model) ? "groq" : "openrouter";
      onProgress?.({
        done: 1,
        total: 1,
        paragraphsDone: chapter.paragraphs.length,
        paragraphsTotal: chapter.paragraphs.length,
      });
      return chapter;
    }
  }

  const pending = chapter.paragraphs
    .map((p, index) => ({ index, text: p.zh, done: Boolean(p.en) }))
    .filter((p) => !p.done && p.text);

  const titleNeedsTranslation = !chapter.titleEn || /[\u4e00-\u9fff]/.test(chapter.titleEn);

  if (!pending.length) {
    if (titleNeedsTranslation && chapter.title) {
      chapter.titleEn = formatChapterTitleRule(chapter.title);
    }
    chapter.contentHash = contentHash;
    setTranslationCache(chapterCacheKey, {
      contentHash,
      paragraphs: chapter.paragraphs,
      titleEn: chapter.titleEn,
      model: modelId,
      promptVersion: PROMPT_VERSION,
    });
    return chapter;
  }

  const isGroq = checkIsGroq(model);
  const effectiveBatchChars = batchChars || (isGroq ? 400 : 1400);
  const maxItems = isGroq ? 4 : 16;
  const groups = batches(pending, effectiveBatchChars, maxItems);

  // ZERO EXTRA API CALL: If title needs translation, prepend it to group 0!
  // It translates simultaneously with paragraph batch 1 in the exact same prompt.
  if (titleNeedsTranslation && chapter.title && groups.length > 0) {
    groups[0].unshift({ isTitle: true, text: chapter.title });
  }

  const context = chapter.paragraphs
    .slice(0, pending[0].index)
    .map((p) => p.en)
    .filter(Boolean)
    .slice(-2);

  let completed = 0;
  const queue = [...groups];

  const progress = () =>
    onProgress?.({
      done: completed,
      total: groups.length,
      paragraphsDone: chapter.paragraphs.filter((p) => p.en).length,
      paragraphsTotal: chapter.paragraphs.length,
    });

  // Keep concurrency 1 to strictly respect free tier rate limits (both Groq OTPM and OpenRouter RPM)
  const concurrency = 1;
  const workers = [];

  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (queue.length) {
          if (shouldAbort?.()) break;
          const group = queue.shift();
          const translations = await translateGroup({ items: group, glossary, context, model, apiKey });
          if (shouldAbort?.()) break;
          group.forEach((item, i) => {
            if (item.isTitle) {
              const rawT = translations[i] ? translations[i].replace(/^["'“”]|["'“”]$/g, "").trim() : "";
              chapter.titleEn = rawT || formatChapterTitleRule(chapter.title);
            } else {
              chapter.paragraphs[item.index].en = translations[i] || "";
            }
          });
          completed += 1;
          progress();
          if (queue.length) {
            const delay = isGroq ? groq.getSafeDelayMs(model) : 600;
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          }
        }
      })(),
    );
  }

  await Promise.all(workers);
  if (!chapter.titleEn) chapter.titleEn = formatChapterTitleRule(chapter.title);
  chapter.contentHash = contentHash;
  chapter.status = "done";
  chapter.isGtxFallback = false;
  chapter.translationProvider = isGroq ? "groq" : "openrouter";

  // Save complete translated chapter to persistent translation cache
  setTranslationCache(chapterCacheKey, {
    contentHash,
    paragraphs: chapter.paragraphs,
    titleEn: chapter.titleEn,
    model: modelId,
    promptVersion: PROMPT_VERSION,
  });

  return chapter;
}

export async function extractGlossary({ chapter, model, apiKey }) {
  const sample = chapter.paragraphs
    .slice(0, 60)
    .map((p) => p.zh)
    .join("\n")
    .slice(0, 4000);

  const prompt = `Extract proper nouns from this Chinese novel excerpt: character names, place names, sect/organization names, cultivation ranks, and recurring special terms.

Return ONLY a JSON array. Each item: {"zh":"中文","en":"English rendering","note":"short category"}.
Rules: use pinyin for names unless a well-known English form exists. Max 40 items. No duplicates.

Excerpt:
${sample}`;

  let raw;
  if (checkIsGroq(model)) {
    raw = await groq.generate(prompt, { model, apiKey });
  } else {
    raw = await openrouter.generate(prompt, { model, apiKey });
  }
  const parsed = parseJsonArray(raw);
  if (!parsed) return [];
  return parsed
    .map((item) => {
      if (typeof item === "string") {
        try {
          item = JSON.parse(item);
        } catch {
          return null;
        }
      }
      if (item?.zh && item?.en) return { zh: item.zh, en: item.en, note: item.note || "" };
      return null;
    })
    .filter(Boolean);
}
