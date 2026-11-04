import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  ROOT,
  chapterStatuses,
  getChapter,
  getGlossary,
  getNovel,
  getToc,
  listNovels,
  loadConfig,
  saveChapter,
  saveConfig,
  saveGlossary,
  saveNovel,
  saveToc,
  slugify,
  getSecret,
  setEnvSecret,
  getHistory,
  recordHistory,
  clearHistory,
} from "./store.mjs";
import { extractChapter, fetchPage, findNextUrl, resolveNovel, fetchFullChapter, fetchCompleteToc, downloadCover, findCoverImage } from "./scrape.mjs";
import { extractGlossary, translateChapter, translateChapterWithGtx, translateTitle, translateTitleBatch, translateDescription } from "./translate.mjs";
import { metrics } from "./metrics.mjs";
import { computeProgress, applyProgressUpdate } from "./progress.mjs";
import { getRecommendationsForNovel } from "./recommend.mjs";
import { executeSmartSearch } from "./search.mjs";
import { clearAllCaches, getRecommendationCache } from "./cache.mjs";
import * as cheerio from "cheerio";
import * as openrouter from "./openrouter.mjs";
import * as groq from "./groq.mjs";

const READER_DIR = path.join(ROOT, "reader");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const jobs = new Map();
const queue = [];
let activeJobs = 0;
const MAX_PARALLEL_JOBS = 2; // run up to 2 chapters concurrently

function publicJob(job) {
  return {
    id: job.id,
    slug: job.slug,
    index: job.index,
    status: job.status,
    progress: job.progress,
    error: job.error,
    provider: job.provider,
    isFallback: job.isFallback,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function enqueue(slug, index, apiKeys = null, options = {}) {
  const id = `${slug}:${index}`;
  const existing = jobs.get(id);
  const normalizedKeys =
    typeof apiKeys === "string"
      ? apiKeys.startsWith("gsk_")
        ? { groq: apiKeys, openrouter: null }
        : { openrouter: apiKeys, groq: null }
      : apiKeys || {};

  if (existing && (existing.status === "queued" || existing.status === "running")) {
    if (normalizedKeys.openrouter || normalizedKeys.groq) {
      existing.apiKeys = { ...existing.apiKeys, ...normalizedKeys };
    }
    if (options.force) existing.force = true;
    if (options.provider) existing.provider = options.provider;
    return existing;
  }
  // If force is true and existing has finished, remove it so it can re-run
  if (options.force && existing) {
    jobs.delete(id);
  }
  const job = {
    id,
    slug,
    index,
    status: "queued",
    apiKeys: normalizedKeys,
    provider: options.provider || normalizedKeys.provider || null,
    force: Boolean(options.force),
    isPrefetch: Boolean(options.isPrefetch),
    isBatch: Boolean(options.isBatch),
    isFallback: false,
    progress: null,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(id, job);
  queue.push(job);
  drain();
  return job;
}

async function drain() {
  // Spawn a new job runner if we have capacity and queue is non-empty
  while (queue.length && activeJobs < MAX_PARALLEL_JOBS) {
    const job = queue.shift();
    if (!job || job.status === "cancelled") continue;
    activeJobs += 1;
    job.status = "running";
    job.startedAt = Date.now();
    // Run concurrently – don't await here so the while loop keeps spawning
    runTranslation(job)
      .then(() => {
        if (job.status !== "cancelled") {
          job.status = "done";
        }
      })
      .catch((err) => {
        if (job.status === "cancelled") return;
        job.status = "error";
        job.error = err.message;
        const chapter = getChapter(job.slug, job.index);
        if (chapter) {
          chapter.status = "error";
          chapter.error = err.message;
          saveChapter(job.slug, job.index, chapter);
        }
      })
      .finally(() => {
        job.finishedAt = Date.now();
        activeJobs -= 1;
        drain(); // check if more queued jobs can now start
      });
  }
}

async function runTranslation(job) {
  if (job.status === "cancelled") return;
  const meta = getNovel(job.slug);
  if (!meta) throw new Error("Novel not found");
  const chapter = await ensureChapter(job.slug, job.index);
  if (job.status === "cancelled") return;
  const glossary = getGlossary(job.slug);
  const config = loadConfig();

  // If force re-translating (e.g. upgrading from GTX fallback to literary AI)
  if (job.force || (chapter.isGtxFallback && job.provider !== "google")) {
    chapter.paragraphs.forEach((p) => { p.en = ""; });
  }

  // Determine requested provider and key availability
  const requestedProvider = job.provider || config.provider || "groq";
  const groqKey = job.apiKeys?.groq || getSecret("groq") || process.env.GROQ_API_KEY;
  const orKey = job.apiKeys?.openrouter || getSecret("openrouter") || process.env.OPENROUTER_API_KEY;
  const hasGroqKey = Boolean(groqKey);
  const hasOrKey = Boolean(orKey);
  const hasAiKey = hasGroqKey || hasOrKey;

  chapter.status = "translating";
  saveChapter(job.slug, job.index, chapter);

  // Debounce progress saves: flush at most once per 2 s during active translation
  let lastSave = 0;
  const flushProgress = (force = false) => {
    const now = Date.now();
    if (force || now - lastSave >= 2000) {
      lastSave = now;
      saveChapter(job.slug, job.index, chapter);
    }
  };

  let result;

  // Case 1: User explicitly chose Google Translate as translation provider
  if (requestedProvider === "google") {
    console.log(`🌐 Translating chapter ${job.index} of "${job.slug}" with Google Translate (GTX)...`);
    job.isFallback = false;
    result = await translateChapterWithGtx({
      chapter,
      onProgress: (progress) => {
        job.progress = progress;
        flushProgress();
      },
      shouldAbort: () => job.status === "cancelled",
      isFallback: false,
    });
  }
  // Case 2: No AI key is present anywhere -> automatic fallback to Google Translate!
  else if (!hasAiKey) {
    console.log(`⚡ No AI API key present. Auto-falling back to Google Translate (GTX) for chapter ${job.index} of "${job.slug}"...`);
    job.isFallback = true;
    result = await translateChapterWithGtx({
      chapter,
      onProgress: (progress) => {
        job.progress = progress;
        flushProgress();
      },
      shouldAbort: () => job.status === "cancelled",
      isFallback: true,
    });
  }
  // Case 3: AI key is available -> attempt Literary AI translation, but if AI quota / network fails, fallback to GTX!
  else {
    try {
      const model = meta.model || config.model;
      const isGroq = requestedProvider === "groq" || (typeof model === "string" ? model.startsWith("groq/") : model?.providerID === "groq");
      const apiKey = isGroq ? (groqKey || orKey) : (orKey || groqKey);

      result = await translateChapter({
        chapter,
        glossary,
        model,
        batchChars: config.batchChars,
        apiKey,
        force: Boolean(job.force),
        onProgress: (progress) => {
          job.progress = progress;
          flushProgress();
        },
        shouldAbort: () => job.status === "cancelled",
      });
      job.isFallback = false;
    } catch (aiErr) {
      console.warn(`⚠️ AI translation failed (${aiErr.message}). Auto-falling back to Google Translate (GTX)...`);
      job.isFallback = true;
      result = await translateChapterWithGtx({
        chapter,
        onProgress: (progress) => {
          job.progress = progress;
          flushProgress();
        },
        shouldAbort: () => job.status === "cancelled",
        isFallback: true,
      });
    }
  }

  if (job.status === "cancelled") return;

  result.status = "done";
  result.translatedAt = Date.now();
  saveChapter(job.slug, job.index, result);
  saveNovel({ ...meta, lastChapter: job.index });

  // Update toc.json with titleEn so drawer and navigation reflect the translated title
  if (result.titleEn) {
    const toc = getToc(job.slug);
    if (toc[job.index - 1] && toc[job.index - 1].titleEn !== result.titleEn) {
      toc[job.index - 1].titleEn = result.titleEn;
      saveToc(job.slug, toc);
    }
  }

  // Only active user-initiated chapter translations trigger bounded lookahead prefetch.
  // Background prefetch jobs (isPrefetch === true) MUST NEVER trigger further prefetch, preventing runaway infinite loops!
  const currentConfig = loadConfig();
  const prefetchLimit = currentConfig.prefetch !== undefined ? Number(currentConfig.prefetch) : 2;
  if (!job.isPrefetch && !job.isBatch && prefetchLimit > 0) {
    const toc = getToc(job.slug);
    for (let i = 1; i <= prefetchLimit; i++) {
      const next = job.index + i;
      if (next <= toc.length && !getChapter(job.slug, next)?.translatedAt) {
        enqueue(job.slug, next, job.apiKeys, { isPrefetch: true, provider: requestedProvider });
      }
    }
  }
}

async function ensureChapter(slug, index) {
  const meta = getNovel(slug);
  if (!meta) throw new HttpError(404, "Novel not found");
  let toc = getToc(slug);
  if (index < 1) throw new HttpError(400, "Chapter index must be >= 1");

  if (index > toc.length) {
    if (meta.chainMode) {
      toc = await extendToc(slug, toc);
    } else {
      // Auto-refresh TOC from source website to discover newly released or paginated chapters
      try {
        const refreshed = await fetchCompleteToc(meta.tocUrl || meta.sourceUrl);
        if (refreshed?.chapters?.length > toc.length) {
          toc = refreshed.chapters;
          saveToc(slug, toc);
          saveNovel({ ...meta, chapterCount: toc.length });
        }
      } catch {}
    }
    if (index > toc.length) throw new HttpError(404, "Chapter out of range");
  }

  const entry = toc[index - 1];
  const existing = getChapter(slug, index);
  if (existing?.paragraphs?.length && (!existing.url || !entry?.url || existing.url === entry.url)) {
    return existing;
  }
  const extracted = await fetchFullChapter(entry.url, { slug, index });
  if (!extracted.paragraphs.length) {
    throw new HttpError(
      422,
      "Could not find chapter text on that page. Use Paste mode to add the chapter manually.",
    );
  }

  // If entry title in TOC was generic (e.g. Chapter 2), enrich it with the newly extracted title
  if (extracted.title && (!entry.title || entry.title.startsWith("Chapter "))) {
    entry.title = extracted.title;
    saveToc(slug, toc);
  }

  const chapter = {
    slug,
    index,
    title: extracted.title || entry.title,
    titleEn: entry.titleEn || "",
    url: entry.url,
    sourceTitle: extracted.title,
    status: "source",
    fetchedAt: Date.now(),
    charCount: extracted.charCount,
    cjkRatio: Number(extracted.cjkRatio.toFixed(3)),
    nextUrl: findNextUrl(extracted.rawHtml || "", entry.url),
    paragraphs: extracted.paragraphs.map((zh) => ({ zh, en: "" })),
  };
  saveChapter(slug, index, chapter);
  return chapter;
}

async function refetchChapter(slug, index) {
  const toc = getToc(slug);
  const entry = toc[index - 1];
  if (!entry?.url) throw new HttpError(404, "Chapter has no source URL (pasted chapter)");
  const old = getChapter(slug, index);
  const extracted = await fetchFullChapter(entry.url, { slug, index });
  if (!extracted.paragraphs.length) throw new HttpError(422, "Could not find chapter text on that page");

  const previous = new Map(
    (old?.paragraphs || []).filter((p) => p.en).map((p) => [p.zh, p.en]),
  );
  const paragraphs = extracted.paragraphs.map((zh) => ({ zh, en: previous.get(zh) || "" }));
  const complete = paragraphs.every((p) => p.en);
  const chapter = {
    ...old,
    slug,
    index,
    title: extracted.title || entry.title,
    sourceTitle: extracted.title,
    url: entry.url,
    charCount: extracted.charCount,
    cjkRatio: Number(extracted.cjkRatio.toFixed(3)),
    nextUrl: findNextUrl(extracted.rawHtml || "", entry.url),
    fetchedAt: Date.now(),
    status: complete ? "done" : "source",
    paragraphs,
  };
  saveChapter(slug, index, chapter);
  return chapter;
}

async function extendToc(slug, toc) {
  const meta = getNovel(slug);
  const last = toc[toc.length - 1];
  if (!last?.url) return toc;
  try {
    const lastPage = await fetchPage(last.url);
    const nextUrl = findNextUrl(lastPage.html, last.url);
    if (!nextUrl) return toc;
    const page = await fetchPage(nextUrl);
    const extracted = extractChapter(page.html, page.finalUrl);
    const next = { index: toc.length + 1, title: extracted.title || `Chapter ${toc.length + 1}`, url: nextUrl };
    const updated = [...toc, next];
    saveToc(slug, updated);
    saveNovel({ ...meta, chapterCount: updated.length });
    return updated;
  } catch {
    return toc;
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method;
  const requestOpenRouterKey = req.headers["x-openrouter-key"] || null;
  const requestGroqKey = req.headers["x-groq-key"] || null;
  const clientKeys = { openrouter: requestOpenRouterKey, groq: requestGroqKey };

  if (method === "GET" && url.pathname === "/api/health") {
    const groqAvailable = groq.isAvailable(requestGroqKey);
    const orAvailable = openrouter.isAvailable(requestOpenRouterKey);
    const orLimits = orAvailable ? await openrouter.checkKeyLimits(requestOpenRouterKey) : null;
    const orExhausted = orLimits?.freeDaily ? orLimits.freeDaily.remaining === 0 : false;
    const bestGroqModel = groq.getBestModelId();
    return json(res, 200, {
      ok: true,
      hasAiKey: groqAvailable || (orAvailable && !orExhausted),
      google: { available: true },
      groq: {
        available: groqAvailable,
        bestModel: bestGroqModel,
        activeModel: groq.getActiveModelId(),
        limits: groq.getLiveLimits(),
      },
      openrouter: { available: orAvailable, exhausted: orExhausted, limits: orLimits },
      model: loadConfig().model,
      provider: loadConfig().provider || "groq",
    });
  }

  if (method === "GET" && url.pathname === "/api/models") {
    const provider = url.searchParams.get("provider");
    const force = url.searchParams.get("refresh") === "true";
    let groqModels = [];
    let orModels = [];

    if (!provider || provider === "groq") {
      try {
        groqModels = await groq.listModels(force, requestGroqKey);
      } catch (err) {
        console.warn("Could not list groq models:", err.message);
      }
    }

    if (!provider || provider === "openrouter") {
      if (openrouter.isAvailable(requestOpenRouterKey)) {
        try {
          orModels = await openrouter.listFreeModels(force, requestOpenRouterKey);
        } catch (err) {
          console.warn("Could not list openrouter models:", err.message);
        }
      }
    }

    return json(res, 200, {
      models: [...groqModels, ...orModels],
      groqModels,
      openrouterModels: orModels,
      bestGroqModel: groq.getBestModelId(),
    });
  }

  if (url.pathname === "/api/config") {
    if (method === "GET") return json(res, 200, loadConfig());
    if (method === "POST") {
      const patch = await readBody(req);
      return json(res, 200, saveConfig(patch));
    }
  }

  // ---- secrets: check key status, quota, or save to .env ----
  if (url.pathname === "/api/secrets") {
    if (method === "GET") {
      const orKey = requestOpenRouterKey || getSecret("openrouter");
      const gKey = requestGroqKey || getSecret("groq");
      const mask = (k) => (k ? `${k.slice(0, 8)}${"•".repeat(Math.max(0, k.length - 12))}${k.slice(-4)}` : null);
      const orLimits = orKey ? await openrouter.checkKeyLimits(orKey) : null;
      const groqCheck = gKey ? await groq.checkKey(gKey) : null;

      return json(res, 200, {
        openrouter: {
          set: Boolean(orKey),
          masked: mask(orKey),
          fromEnv: Boolean(process.env.OPENROUTER_API_KEY),
          limits: orLimits,
        },
        groq: {
          set: Boolean(gKey),
          masked: mask(gKey),
          fromEnv: Boolean(process.env.GROQ_API_KEY),
          valid: groqCheck?.valid ?? false,
          modelCount: groqCheck?.modelCount ?? 0,
          bestModel: groq.getBestModelId(),
          activeModel: groq.getActiveModelId(),
          limits: groqCheck?.limits || groq.getLiveLimits(),
        },
      });
    }

    if (method === "POST") {
      const body = await readBody(req);
      if (body.provider === "groq") {
        if (body.key !== undefined) {
          setEnvSecret("GROQ_API_KEY", body.key ? body.key.trim() : null);
          groq.bustCache();
        }
      } else if (body.provider === "openrouter") {
        if (body.key !== undefined) {
          setEnvSecret("OPENROUTER_API_KEY", body.key ? body.key.trim() : null);
          openrouter.bustCache();
        }
      }
      return json(res, 200, { ok: true });
    }

    throw new HttpError(405, "Method not allowed.");
  }

  // ---- reading history ----
  if (url.pathname === "/api/history") {
    if (method === "GET") return json(res, 200, { history: getHistory() });
    if (method === "DELETE") {
      clearHistory();
      return json(res, 200, { ok: true });
    }
    throw new HttpError(405, "Method not allowed.");
  }

  // ---- cache observability & admin ----
  if (url.pathname === "/api/cache/stats" && method === "GET") {
    return json(res, 200, metrics.getStats());
  }

  if (url.pathname === "/api/cache/clear" && method === "POST") {
    clearAllCaches();
    return json(res, 200, { ok: true, message: "All caches cleared" });
  }

  if (method === "GET" && url.pathname === "/api/novels") {
    const rawNovels = listNovels();

    // Fast-batch translate any titles still in Chinese (<200ms via Google GTX)
    const needsTitle = rawNovels.filter((n) => n.title && (!n.titleEn || /[\u4e00-\u9fff]/.test(n.titleEn)));
    if (needsTitle.length > 0) {
      try {
        const titles = needsTitle.map((n) => n.title);
        const trans = await Promise.race([
          translateTitleBatch(titles, { type: "novel" }),
          new Promise((_, r) => setTimeout(() => r(new Error("Timeout")), 1200)),
        ]);
        if (Array.isArray(trans)) {
          needsTitle.forEach((n, i) => {
            if (trans[i] && trans[i] !== n.title && !/[\u4e00-\u9fff]/.test(trans[i])) {
              n.titleEn = trans[i];
              saveNovel(n);
            }
          });
        }
      } catch {}
    }

    // Cover backfill in background
    for (const n of rawNovels) {
      if (!n.cover && n.sourceUrl) {
        fetchPage(n.sourceUrl).then(async (p) => {
          const $ = cheerio.load(p.html);
          const cUrl = findCoverImage($, p.finalUrl, n.title);
          if (cUrl) {
            const local = await downloadCover(n.slug, cUrl, p.finalUrl);
            if (local) {
              const cur = getNovel(n.slug);
              if (cur) {
                cur.cover = local;
                cur.coverUrl = cUrl;
                saveNovel(cur);
              }
            }
          }
        }).catch(() => {});
      }
    }

    const novels = rawNovels.map((n) => {
      const toc = getToc(n.slug);
      const progress = computeProgress(n, toc);
      return {
        ...n,
        progress,
        chapterCount: toc.length || n.chapterCount || 0,
      };
    });

    return json(res, 200, { novels });
  }

  if (method === "POST" && url.pathname === "/api/smart-search") {
    const { query, maxResults = 25, page = 1, excludeUrls = [] } = await readBody(req);
    if (!query || !String(query).trim()) {
      return json(res, 200, {
        query: "",
        googleZh: "",
        aiVariants: [],
        sitesSearched: [],
        totalResults: 0,
        page: 1,
        hasMore: false,
        results: [],
      });
    }
    const searchRes = await executeSmartSearch(query, {
      model: loadConfig().model,
      apiKey: clientKeys.groq || clientKeys.openrouter,
      page: Number(page) || 1,
      maxResults: Number(maxResults) || 25,
      excludeUrls: Array.isArray(excludeUrls) ? excludeUrls : [],
    });
    return json(res, 200, searchRes);
  }

  if (method === "POST" && url.pathname === "/api/import") {
    const { url: input, inLibrary } = await readBody(req);
    if (!input) throw new HttpError(400, "Missing url");
    const resolved = await resolveNovel(input);
    const cleanT = (resolved.title || "")
      .replace(/\s*(最新章节|全文阅读|免费阅读|无弹窗|txt下载|列表|目录)\s*$/gi, "")
      .trim();
    const slug = slugify(`${cleanT}|${new URL(resolved.finalUrl).origin}`);

    // Translate novel title to English (fast Google GTX)
    let titleEn = cleanT;
    try {
      const translated = await translateTitle(cleanT, "novel", {
        model: loadConfig().model,
        apiKey: clientKeys.groq || clientKeys.openrouter,
      });
      if (translated) titleEn = translated;
    } catch {}

    // Translate novel description to English if available
    let descriptionEn = "";
    if (resolved.description && /[\u4e00-\u9fff]/.test(resolved.description)) {
      try {
        const transDesc = await translateDescription(resolved.description, {
          model: loadConfig().model,
          apiKey: clientKeys.groq || clientKeys.openrouter,
        });
        if (transDesc && transDesc !== resolved.description) {
          descriptionEn = transDesc;
        }
      } catch {}
    }

    // Download cover in background without blocking response
    let cover = null;
    if (resolved.coverUrl) {
      downloadCover(slug, resolved.coverUrl, resolved.finalUrl).then((c) => {
        if (c) {
          const cur = getNovel(slug);
          if (cur && !cur.cover) {
            cur.cover = c;
            saveNovel(cur);
          }
        }
      }).catch(() => {});
    }

    const existing = getNovel(slug);
    if (existing) {
      if (!existing.titleEn && titleEn) existing.titleEn = titleEn;
      if (descriptionEn && !existing.descriptionEn) existing.descriptionEn = descriptionEn;
      if (!existing.cover && cover) {
        existing.cover = cover;
        existing.coverUrl = resolved.coverUrl;
      }
      if (resolved.author && (!existing.author || existing.author === "Unknown Author")) {
        existing.author = resolved.author;
      }
      if (resolved.description && (!existing.description || existing.description.length < resolved.description.length)) {
        existing.description = resolved.description;
      }

      // If existing had only partial chapters and resolved found more, update TOC
      let currentToc = getToc(slug);
      if (resolved.chapters?.length > currentToc.length) {
        saveToc(slug, resolved.chapters);
        existing.chapterCount = resolved.chapters.length;
        currentToc = resolved.chapters;
        if (resolved.tocUrl) existing.tocUrl = resolved.tocUrl;
      }
      if (resolved.recommendations?.length) {
        existing.recommendations = resolved.recommendations;
      }
      if (inLibrary === true) {
        existing.inLibrary = true;
      }
      saveNovel(existing);
      const progress = computeProgress(existing, currentToc);
      return json(res, 200, { novel: existing, toc: currentToc, existed: true, startIndex: resolved.startIndex, progress });
    }

    const meta = saveNovel({
      slug,
      title: cleanT,
      titleEn,
      author: resolved.author || "",
      description: resolved.description || "",
      descriptionEn,
      coverUrl: resolved.coverUrl || null,
      cover: cover || null,
      sourceUrl: resolved.finalUrl,
      tocUrl: resolved.tocUrl,
      chainMode: resolved.chainMode,
      sourceLang: "zh",
      targetLang: "en",
      model: loadConfig().model,
      createdAt: Date.now(),
      lastChapter: resolved.startIndex || 1,
      readChapters: [],
      chapterCount: resolved.chapters.length,
      recommendations: resolved.recommendations || [],
      inLibrary: inLibrary !== false,
    });
    saveToc(slug, resolved.chapters);
    const progress = computeProgress(meta, resolved.chapters);
    return json(res, 200, { novel: meta, toc: resolved.chapters, startIndex: resolved.startIndex, progress });
  }

  if (parts[1] === "novels" && parts[2]) {
    const slug = decodeURIComponent(parts[2]);

    // Cover image stream route: /api/novels/:slug/cover
    if (parts[3] === "cover" && method === "GET") {
      const coverPath = path.join(ROOT, "novels", slug, "cover.jpg");
      if (fs.existsSync(coverPath)) {
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=86400",
        });
        return fs.createReadStream(coverPath).pipe(res);
      }
      const novelMeta = getNovel(slug);
      if (novelMeta?.coverUrl) {
        const local = await downloadCover(slug, novelMeta.coverUrl, novelMeta.sourceUrl);
        if (local && fs.existsSync(coverPath)) {
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=86400",
          });
          return fs.createReadStream(coverPath).pipe(res);
        }
      }
      throw new HttpError(404, "Cover not found");
    }

    const meta = getNovel(slug);
    if (!meta) throw new HttpError(404, "Novel not found");

    if (parts.length === 3 && method === "GET") {
      const toc = getToc(slug);
      const progress = computeProgress(meta, toc);
      const rawRecs = (meta.recommendations && meta.recommendations.length) ? meta.recommendations : (getRecommendationCache(slug) || []);
      const needsRecsTranslation = !rawRecs.length || rawRecs.some((r) =>
        /[\u4e00-\u9fff]/.test(r.titleEn || r.title || "") ||
        /[\u4e00-\u9fff]/.test(r.synopsis || "")
      );

      // Fast auto-translate title and description if still Chinese (<200ms via Google GTX)
      const transPromises = [];
      if (meta.title && (!meta.titleEn || /[\u4e00-\u9fff]/.test(meta.titleEn))) {
        transPromises.push(
          translateTitle(meta.title, "novel").then((t) => {
            if (t && t !== meta.title && !/[\u4e00-\u9fff]/.test(t)) {
              meta.titleEn = t;
              saveNovel(meta);
            }
          }).catch(() => {})
        );
      }

      if (meta.description && (!meta.descriptionEn || /[\u4e00-\u9fff]/.test(meta.descriptionEn))) {
        transPromises.push(
          translateDescription(meta.description).then((d) => {
            if (d && d !== meta.description && !/[\u4e00-\u9fff]/.test(d)) {
              meta.descriptionEn = d;
              saveNovel(meta);
            }
          }).catch(() => {})
        );
      }

      if (transPromises.length > 0) {
        try {
          await Promise.race([
            Promise.all(transPromises),
            new Promise((_, r) => setTimeout(() => r(new Error("Timeout")), 1200)),
          ]);
        } catch {}
      }

      // Fast resolution for recommendations: if recommendations need translation, attempt fast fetch (<1.5s)
      let recommendations = rawRecs;
      if (needsRecsTranslation && (meta.sourceUrl || meta.tocUrl)) {
        try {
          const freshRecs = await Promise.race([
            getRecommendationsForNovel(meta),
            new Promise((_, r) => setTimeout(() => r(new Error("Timeout")), 1500)),
          ]);
          if (Array.isArray(freshRecs) && freshRecs.length > 0) {
            recommendations = freshRecs;
          }
        } catch {
          // If timeout exceeded, continue in background
          getRecommendationsForNovel(meta).catch(() => {});
        }
      }

      return json(res, 200, {
        novel: meta,
        toc,
        statuses: chapterStatuses(slug),
        glossary: getGlossary(slug),
        progress,
        recommendations,
      });
    }

    if (parts[3] === "translate-description" && method === "POST") {
      if (meta.description) {
        const descriptionEn = await translateDescription(meta.description, {
          model: loadConfig().model,
          apiKey: clientKeys.groq || clientKeys.openrouter,
        });
        if (descriptionEn && descriptionEn !== meta.description) {
          meta.descriptionEn = descriptionEn;
          saveNovel(meta);
          return json(res, 200, { ok: true, descriptionEn });
        }
      }
      return json(res, 200, { ok: true, descriptionEn: meta.descriptionEn || meta.description });
    }

    if (parts[3] === "recommendations" && method === "GET") {
      const recommendations = await getRecommendationsForNovel(meta);
      return json(res, 200, { recommendations });
    }

    if (parts[3] === "library" && method === "POST") {
      const body = await readBody(req);
      meta.inLibrary = body.inLibrary !== false;
      saveNovel(meta);
      return json(res, 200, { ok: true, novel: meta, inLibrary: meta.inLibrary });
    }

    if (parts[3] === "progress" && method === "POST") {
      const body = await readBody(req);
      const toc = getToc(slug);
      const { meta: updatedMeta, progress } = applyProgressUpdate(meta, toc, body);
      saveNovel(updatedMeta);

      const chapterIndex = updatedMeta.lastChapter;
      const curChapter = toc[chapterIndex - 1];
      recordHistory({
        slug: updatedMeta.slug,
        title: updatedMeta.title,
        titleEn: updatedMeta.titleEn || updatedMeta.title,
        author: updatedMeta.author || "",
        cover: updatedMeta.cover,
        coverUrl: updatedMeta.coverUrl,
        chapterIndex,
        chapterTitle: curChapter?.title || `Chapter ${chapterIndex}`,
        chapterTitleEn: curChapter?.titleEn || null,
        totalChapters: toc.length,
        progressPercent: progress.progressPercent,
      });

      return json(res, 200, { ok: true, novel: updatedMeta, progress });
    }

    if (parts[3] === "mark-read" && method === "POST") {
      const body = await readBody(req);
      const toc = getToc(slug);
      const readSet = new Set(Array.isArray(meta.readChapters) ? meta.readChapters : []);

      if (body.reset) {
        readSet.clear();
        meta.lastChapter = 1;
      } else if (body.readAll) {
        for (let i = 1; i <= toc.length; i++) readSet.add(i);
      } else if (body.chapter !== undefined) {
        const ch = Number(body.chapter);
        if (body.read === false) {
          readSet.delete(ch);
          if (meta.lastChapter === ch) {
            meta.scrollPercent = 0;
            meta.scrollY = 0;
            const sorted = Array.from(readSet).sort((a, b) => a - b);
            meta.lastChapter = sorted.length ? sorted[sorted.length - 1] : 1;
          }
        } else {
          readSet.add(ch);
          meta.lastChapter = ch;
        }
      }

      meta.readChapters = Array.from(readSet).sort((a, b) => a - b);
      const progress = computeProgress(meta, toc);
      meta.progressPercent = progress.progressPercent;
      meta.isCompleted = progress.isCompleted;
      saveNovel(meta);

      return json(res, 200, { ok: true, novel: meta, progress });
    }

    if (parts[3] === "chapter" && parts[4]) {
      const index = Number(parts[4]);
      if (!Number.isInteger(index) || index < 1) throw new HttpError(400, "Bad chapter index");

      if (method === "GET" && parts.length === 5) {
        const chapter = await ensureChapter(slug, index);
        const groqKey = requestGroqKey || getSecret("groq") || process.env.GROQ_API_KEY;
        const orKey = requestOpenRouterKey || getSecret("openrouter") || process.env.OPENROUTER_API_KEY;
        const hasAiKey = Boolean(groqKey || orKey);
        return json(res, 200, { chapter, total: getToc(slug).length, hasAiKey });
      }

      if (method === "POST" && parts[5] === "translate") {
        await ensureChapter(slug, index);
        const body = await readBody(req).catch(() => ({}));
        const reqProvider = req.headers["x-provider"] || body.provider || null;
        const job = enqueue(
          slug,
          index,
          { ...clientKeys, provider: reqProvider },
          { force: Boolean(body.force), provider: reqProvider }
        );
        return json(res, 200, { job: publicJob(job) });
      }

      if (method === "POST" && parts[5] === "refetch") {
        const chapter = await refetchChapter(slug, index);
        return json(res, 200, { chapter });
      }

      if (method === "POST" && parts[5] === "paste") {
        const body = await readBody(req);
        const lines = String(body.text || "")
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (!lines.length) throw new HttpError(400, "No text provided");
        const toc = getToc(slug);
        const chapter = {
          slug,
          index,
          title: body.title || toc[index - 1]?.title || `Chapter ${index}`,
          url: toc[index - 1]?.url || null,
          sourceTitle: body.title || "",
          status: "source",
          fetchedAt: Date.now(),
          charCount: lines.join("").length,
          pasted: true,
          paragraphs: lines.map((zh) => ({ zh, en: "" })),
        };
        saveChapter(slug, index, chapter);
        return json(res, 200, { chapter });
      }
    }

    if (method === "POST" && parts[3] === "toc" && parts[4] === "refresh") {
      const targetUrl = meta.tocUrl || meta.sourceUrl;
      const refreshed = await fetchCompleteToc(targetUrl);
      if (refreshed?.chapters?.length) {
        saveToc(slug, refreshed.chapters);
        meta.chapterCount = refreshed.chapters.length;
        if (refreshed.finalTocUrl) meta.tocUrl = refreshed.finalTocUrl;
        saveNovel(meta);
        return json(res, 200, {
          ok: true,
          chapterCount: refreshed.chapters.length,
          toc: refreshed.chapters,
        });
      }
      return json(res, 200, { ok: false, chapterCount: getToc(slug).length });
    }

    if (method === "POST" && parts[3] === "toc" && parts[4] === "translate-titles") {
      const { from = 1, count = 50 } = await readBody(req);
      const toc = getToc(slug);
      const startIdx = Math.max(1, Number(from) || 1);
      const batchCount = Math.min(60, Math.max(1, Number(count) || 50));
      const slice = toc.slice(startIdx - 1, startIdx - 1 + batchCount);
      const titles = slice.map((c) => c.title);

      const translatedTitles = await translateTitleBatch(titles, {
        model: loadConfig().model,
        apiKey: clientKeys.groq || clientKeys.openrouter,
      });

      slice.forEach((c, idx) => {
        if (translatedTitles[idx]) {
          c.titleEn = translatedTitles[idx];
        }
      });

      saveToc(slug, toc);
      return json(res, 200, {
        ok: true,
        from: startIdx,
        count: slice.length,
        toc: getToc(slug),
      });
    }

    if (method === "POST" && parts[3] === "translate-range") {
      const { from = 1, count = 5 } = await readBody(req);
      const reqProvider = req.headers["x-provider"] || null;
      const toc = getToc(slug);
      const startIdx = Math.max(1, Number(from) || 1);
      const batchCount = Math.min(100, Math.max(1, Number(count) || 5));
      const started = [];
      for (let i = startIdx; i < startIdx + batchCount && i <= toc.length; i++) {
        const existing = getChapter(slug, i);
        if (!existing?.translatedAt) {
          started.push(publicJob(enqueue(slug, i, { ...clientKeys, provider: reqProvider }, { isBatch: true, isPrefetch: true, provider: reqProvider })));
        }
      }
      return json(res, 200, { ok: true, from: startIdx, count: started.length, jobs: started });
    }

    if (method === "POST" && parts[3] === "cancel-translate") {
      let cancelledCount = 0;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].slug === slug) {
          queue[i].status = "cancelled";
          queue.splice(i, 1);
          cancelledCount++;
        }
      }
      for (const job of jobs.values()) {
        if (job.slug === slug && job.status === "running") {
          job.status = "cancelled";
          cancelledCount++;
        }
      }
      return json(res, 200, { ok: true, cancelled: cancelledCount });
    }

    if (parts[3] === "glossary") {
      if (method === "GET") return json(res, 200, getGlossary(slug));
      if (method === "POST") {
        const body = await readBody(req);
        const glossary = { terms: body.terms ?? [], policy: body.policy ?? {} };
        saveGlossary(slug, glossary);
        return json(res, 200, glossary);
      }
      if (method === "PUT") {
        const chapter = await ensureChapter(slug, 1);
        const targetModel = meta.model || loadConfig().model;
        const isGroq = targetModel?.providerID === "groq" || (typeof targetModel === "string" && targetModel.startsWith("groq/"));
        const glossaryApiKey = isGroq
          ? (requestGroqKey || getSecret("groq"))
          : (requestOpenRouterKey || getSecret("openrouter"));
        const terms = await extractGlossary({
          chapter,
          model: targetModel,
          apiKey: glossaryApiKey,
        });
        const merged = { ...getGlossary(slug), terms };
        saveGlossary(slug, merged);
        return json(res, 200, merged);
      }
    }

    if (method === "PATCH" && parts.length === 3) {
      const patch = await readBody(req);
      return json(res, 200, saveNovel({ ...meta, ...patch, slug }));
    }

    if (method === "DELETE" && parts.length === 3) {
      fs.rmSync(path.join(ROOT, "novels", slug), { recursive: true, force: true });
      return json(res, 200, { deleted: true });
    }
  }

  if (method === "GET" && url.pathname === "/api/jobs") {
    return json(res, 200, { jobs: [...jobs.values()].map(publicJob).slice(-200) });
  }

  if (method === "POST" && url.pathname === "/api/jobs/cancel") {
    const { slug } = await readBody(req);
    let cancelledCount = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!slug || queue[i].slug === slug) {
        queue[i].status = "cancelled";
        queue.splice(i, 1);
        cancelledCount++;
      }
    }
    for (const job of jobs.values()) {
      if ((!slug || job.slug === slug) && job.status === "running") {
        job.status = "cancelled";
        cancelledCount++;
      }
    }
    return json(res, 200, { ok: true, cancelled: cancelledCount });
  }

  throw new HttpError(404, "Not found");
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.join(READER_DIR, path.normalize(pathname).replace(/^([/\\])+/, ""));
  if (!file.startsWith(READER_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "pragma": "no-cache",
      "expires": "0",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    json(res, status, { error: err.message });
  }
});

const config = loadConfig();
const port = process.env.PORT ? Number(process.env.PORT) : config.port;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n[ERROR] Port ${port} is already in use by another process.`);
    console.error(`Please close any existing instance or run run.bat to clear the port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`novel reader  →  http://127.0.0.1:${port}`);
});
