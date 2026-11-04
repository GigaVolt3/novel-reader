import { getContentHash, getEmbeddingCache, setEmbeddingCache, getRecommendationCache, setRecommendationCache, buildEmbeddingKey } from "./cache.mjs";
import { listNovels, saveNovel } from "./store.mjs";
import { fetchPage, extractRecommendations, findInfoUrl } from "./scrape.mjs";
import { translateTitleBatch, translateSynopsisBatch } from "./translate.mjs";
import * as cheerio from "cheerio";

export function translateTag(tag) {
  if (!tag) return "";
  const t = String(tag).trim();

  // Word count pattern e.g. 378.92万字, 50万字, 12000字
  const wordMatch = t.match(/^(\d+(?:\.\d+)?)\s*万字?$/);
  if (wordMatch) {
    const wan = parseFloat(wordMatch[1]);
    if (wan >= 100) {
      return `${(wan / 100).toFixed(2)}M words`;
    }
    return `${Math.round(wan * 10)}K words`;
  }
  const rawWords = t.match(/^(\d+)\s*字$/);
  if (rawWords) {
    const num = parseInt(rawWords[1], 10);
    return num >= 1000000 ? `${(num / 1000000).toFixed(2)}M words` : `${Math.round(num / 1000)}K words`;
  }

  const map = {
    "连载": "Ongoing",
    "完本": "Completed",
    "完结": "Completed",
    "全本": "Completed",
    "玄幻魔法": "Fantasy",
    "东方玄幻": "Eastern Fantasy",
    "异界大陆": "Otherworld Fantasy",
    "传统玄幻": "Traditional Fantasy",
    "仙侠": "Cultivation",
    "修仙": "Cultivation",
    "修真": "Cultivation",
    "古典仙侠": "Cultivation",
    "幻想修仙": "Cultivation",
    "现代修真": "Modern Cultivation",
    "玄幻": "Fantasy",
    "奇幻": "Western Fantasy",
    "都市": "Urban",
    "都市生活": "Urban Life",
    "都市异能": "Urban Supernatural",
    "都市重生": "Urban Rebirth",
    "科幻": "Sci-Fi",
    "科幻未来": "Sci-Fi",
    "轻小说": "Light Novel",
    "历史": "Historical",
    "历史争霸": "Historical",
    "架空历史": "Alternate History",
    "军事": "Military",
    "武侠": "Martial Arts",
    "游戏": "Gaming",
    "网游": "Gaming",
    "游戏异界": "LitRPG / Gaming",
    "虚拟网游": "Gaming",
    "悬疑": "Mystery",
    "恐怖": "Horror",
    "灵异": "Supernatural",
    "同人": "Fanfiction",
    "短篇": "Short Story",
    "末世": "Apocalyptic",
    "末日": "Apocalyptic",
    "系统": "System",
    "穿越": "Transmigration",
    "重生": "Rebirth",
    "种田": "Farming",
    "无敌": "Invincible",
    "日常": "Daily Life",
    "恋爱": "Romance",
    "青春": "Youth",
    "热血": "Action",
    "争霸": "Kingdom Building",
    "后宫": "Harem",
    "单女主": "Single Heroine",
    "多女主": "Harem",
    "无女主": "No Romance",
    "搞笑": "Comedy",
    "爽文": "Power Fantasy",
    "二次元": "Anime",
    "魔法": "Magic",
  };

  if (map[t]) return map[t];
  if (t.includes("玄幻") || t.includes("魔法")) return "Fantasy";
  if (t.includes("仙侠") || t.includes("修仙") || t.includes("修真")) return "Cultivation";
  if (t.includes("科幻")) return "Sci-Fi";
  if (t.includes("都市")) return "Urban";
  if (t.includes("历史")) return "Historical";
  if (t.includes("武侠")) return "Martial Arts";
  if (t.includes("游戏") || t.includes("网游")) return "Gaming";
  if (t.includes("悬疑") || t.includes("恐怖")) return "Mystery";
  if (t.includes("穿越") || t.includes("重生")) return "Rebirth";
  if (t.includes("连载")) return "Ongoing";
  if (t.includes("完结") || t.includes("完本")) return "Completed";

  return t;
}

export function translateTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map(translateTag).filter(Boolean);
}

const GENRE_TAGS = [
  { id: "dynasty", label: "Dynasty & Empire", zh: ["皇朝", "争霸", "大秦", "大唐", "汉室", "皇帝", "召唤", "影密卫", "诸侯", "天下", "锦衣卫"] },
  { id: "xianxia", label: "Cultivation & Xianxia", zh: ["修仙", "玄幻", "仙侠", "灵气", "金丹", "元婴", "宗门", "飞升", "天道", "洪荒"] },
  { id: "system", label: "System & LitRPG", zh: ["系统", "签到", "神级", "无敌", "抽奖", "觉醒", "面板", "开局"] },
  { id: "transmigration", label: "Transmigration & Rebirth", zh: ["穿越", "重生", "逆袭", "夺舍", "再世"] },
  { id: "action", label: "Martial Arts & Action", zh: ["武侠", "宗师", "武道", "肉身", "神功", "剑神", "拳霸"] },
  { id: "urban", label: "Urban & Modern", zh: ["都市", "学霸", "神医", "重生", "首富", "日常", "文娱"] },
];

/**
 * Identify primary genre tags of a novel from text
 */
export function detectGenreTags(text = "") {
  const matches = [];
  for (const genre of GENRE_TAGS) {
    let score = 0;
    for (const kw of genre.zh) {
      if (text.includes(kw)) score += 1;
    }
    if (score > 0) matches.push({ genre, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.map((m) => m.genre);
}

/**
 * Get recommendations for a novel strictly from its source website.
 * Each novel page displays genuine recommendations extracted from that novel's source page.
 * Fully interactive with real clickable source links and 1-click library import.
 */
export async function getRecommendationsForNovel(novel) {
  if (!novel?.slug) return [];

  // 1. Check recommendation cache first (only accept if it has real sourceUrls and valid covers)
  const cached = getRecommendationCache(novel.slug);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    const hasValidRealLinks = cached.some((r) => r.sourceUrl);
    const isDegradedCache = cached.every((r) => !r.coverUrl && !r.cover);
    if (hasValidRealLinks && !isDegradedCache) {
      // If cached recommendations have untranslated Chinese titles or synopses, batch-translate them
      const hasChinese = cached.some(
        (r) => /[\u4e00-\u9fff]/.test(r.titleEn || r.title || "") || /[\u4e00-\u9fff]/.test(r.synopsis || "")
      );
      if (hasChinese) {
        const titlesToTranslate = cached.map((r) =>
          r.titleZh && (!r.titleEn || /[\u4e00-\u9fff]/.test(r.titleEn)) ? r.titleZh : ""
        );
        const synopsesToTranslate = cached.map((r) =>
          r.synopsis && /[\u4e00-\u9fff]/.test(r.synopsis) ? r.synopsis : ""
        );
        try {
          const [tRes, sRes] = await Promise.all([
            titlesToTranslate.some(Boolean) ? translateTitleBatch(titlesToTranslate, { type: "novel" }) : null,
            synopsesToTranslate.some(Boolean) ? translateSynopsisBatch(synopsesToTranslate) : null,
          ]);
          if (Array.isArray(tRes)) {
            cached.forEach((r, idx) => {
              if (tRes[idx] && tRes[idx] !== titlesToTranslate[idx] && !/[\u4e00-\u9fff]/.test(tRes[idx])) {
                r.title = tRes[idx];
                r.titleEn = tRes[idx];
              }
            });
          }
          if (Array.isArray(sRes)) {
            cached.forEach((r, idx) => {
              if (sRes[idx] && sRes[idx] !== synopsesToTranslate[idx]) {
                r.synopsis = sRes[idx];
                r.synopsisEn = sRes[idx];
              }
            });
          }
          setRecommendationCache(novel.slug, cached);
          novel.recommendations = cached;
          try {
            saveNovel(novel);
          } catch {}
        } catch {}
      }

      const libraryNovels = listNovels();
      const mapped = cached.map((r) => {
        const matched = libraryNovels.find(
          (n) =>
            n.slug === r.slug ||
            (r.sourceUrl && n.sourceUrl && r.sourceUrl.replace(/\/$/, "") === n.sourceUrl.replace(/\/$/, "")) ||
            (n.title && r.titleZh && n.title.trim().toLowerCase() === r.titleZh.trim().toLowerCase())
        );
        if (matched) {
          return {
            ...r,
            inLibrary: true,
            slug: matched.slug,
            titleEn: matched.titleEn || r.titleEn || r.title,
            cover: matched.cover || r.coverUrl || null,
          };
        }
        return { ...r, inLibrary: false, slug: null };
      });

      // Synchronize with novel.recommendations in meta.json if novel lacks rich covers
      if (!novel.recommendations?.length || novel.recommendations.every((r) => !r.coverUrl && !r.cover)) {
        novel.recommendations = mapped;
        try {
          saveNovel(novel);
        } catch {}
      }

      return mapped;
    }
  }

  const libraryNovels = listNovels();
  let siteRecs = Array.isArray(novel.recommendations) ? [...novel.recommendations] : [];
  const isSiteRecsDegraded = !siteRecs.length || siteRecs.every((r) => !r.coverUrl && !r.cover);

  // 2. If novel doesn't have site recommendations or they are degraded (no covers/synopses), fetch directly
  if (isSiteRecsDegraded && (novel.sourceUrl || novel.tocUrl)) {
    try {
      const targetUrl = novel.sourceUrl || novel.tocUrl;
      const p = await fetchPage(targetUrl);
      const $ = cheerio.load(p.html);
      let extracted = extractRecommendations($, p.finalUrl, novel.title);

      // If recommendations on TOC page are degraded or missing, search for the novel info page
      const isExtractedDegraded = !extracted.length || extracted.every((r) => !r.coverUrl && !r.synopsis);
      if (isExtractedDegraded) {
        const infoUrl = findInfoUrl($, p.finalUrl);
        if (infoUrl && infoUrl !== p.finalUrl) {
          try {
            const infoP = await fetchPage(infoUrl);
            const info$ = cheerio.load(infoP.html);
            const infoRecs = extractRecommendations(info$, infoP.finalUrl, novel.title);
            if (infoRecs.length > 0 && infoRecs.some((r) => r.coverUrl || r.synopsis)) {
              extracted = infoRecs;
            }
          } catch {}
        }
      }

      if (extracted.length > 0) {
        siteRecs = extracted;
        novel.recommendations = extracted;
        try {
          saveNovel(novel);
        } catch {}
      }
    } catch (err) {
      // ignore fetch errors
    }
  }

  const results = [];
  const seenTitles = new Set();
  const seenUrls = new Set();
  if (novel.title) seenTitles.add(novel.title.trim().toLowerCase());

  // 3. Populate recommendations exclusively from the novel's source website
  for (const rec of siteRecs) {
    const t = (rec.title || "").trim();
    const tLower = t.toLowerCase();
    if (!t || seenTitles.has(tLower)) continue;

    const u = (rec.sourceUrl || "").trim();
    if (u && seenUrls.has(u)) continue;

    seenTitles.add(tLower);
    if (u) seenUrls.add(u);

    // Cross-reference with user library to indicate if the user already has this novel
    const matched = libraryNovels.find(
      (n) =>
        (u && n.sourceUrl && u.replace(/\/$/, "") === n.sourceUrl.replace(/\/$/, "")) ||
        (n.title && n.title.trim().toLowerCase() === tLower)
    );

    if (matched) {
      results.push({
        slug: matched.slug,
        title: matched.titleEn || matched.title,
        titleZh: matched.title,
        titleEn: matched.titleEn || matched.title,
        author: matched.author || rec.author || "Unknown",
        cover: matched.cover || rec.coverUrl || null,
        coverUrl: rec.coverUrl || null,
        tags: translateTags(rec.tags?.length ? rec.tags : detectGenreTags(rec.synopsis || "").map((g) => g.label).slice(0, 2)),
        synopsis: matched.descriptionEn || rec.synopsisEn || rec.synopsis || "",
        synopsisZh: rec.synopsis || "",
        sourceUrl: rec.sourceUrl || null,
        inLibrary: true,
      });
    } else {
      results.push({
        slug: null,
        title: rec.titleEn || rec.title,
        titleZh: rec.titleZh || rec.title,
        titleEn: rec.titleEn || rec.title,
        author: rec.author || "Unknown",
        cover: null,
        coverUrl: rec.coverUrl || null,
        tags: translateTags(rec.tags?.length ? rec.tags : detectGenreTags(rec.synopsis || "").map((g) => g.label).slice(0, 2)),
        synopsis: rec.synopsisEn || rec.synopsis || "",
        synopsisZh: rec.synopsis || "",
        sourceUrl: rec.sourceUrl || null,
        inLibrary: false,
      });
    }
  }

  const topSlice = results.slice(0, 10);

  // 4. Batch translate Chinese titles and synopses to English
  const titlesToTranslate = topSlice.map((item) =>
    item.titleZh && (!item.titleEn || /[\u4e00-\u9fff]/.test(item.titleEn)) ? item.titleZh : ""
  );

  const synopsesToTranslate = topSlice.map((item) =>
    item.synopsis && /[\u4e00-\u9fff]/.test(item.synopsis) ? item.synopsis : ""
  );

  try {
    const promises = [];
    if (titlesToTranslate.some(Boolean)) {
      promises.push(
        translateTitleBatch(titlesToTranslate, { type: "novel" }).then((trans) => {
          if (Array.isArray(trans)) {
            topSlice.forEach((item, idx) => {
              if (trans[idx] && trans[idx] !== titlesToTranslate[idx] && !/[\u4e00-\u9fff]/.test(trans[idx])) {
                item.title = trans[idx];
                item.titleEn = trans[idx];
              }
            });
          }
        })
      );
    }

    if (synopsesToTranslate.some(Boolean)) {
      promises.push(
        translateSynopsisBatch(synopsesToTranslate).then((trans) => {
          if (Array.isArray(trans)) {
            topSlice.forEach((item, idx) => {
              if (trans[idx] && trans[idx] !== synopsesToTranslate[idx]) {
                item.synopsis = trans[idx];
                item.synopsisEn = trans[idx];
              }
            });
          }
        })
      );
    }

    if (promises.length) {
      await Promise.race([
        Promise.all(promises),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 9000)),
      ]);
    }
  } catch {}

  // 5. Persist the updated translated recommendations directly into the novel metadata
  novel.recommendations = topSlice;
  try {
    saveNovel(novel);
  } catch (err) {
    console.warn("Failed to persist recommendations to novel:", err?.message);
  }

  setRecommendationCache(novel.slug, topSlice);
  return topSlice;
}
