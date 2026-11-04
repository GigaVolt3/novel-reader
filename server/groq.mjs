import path from "node:path";
import { ROOT, readJson, writeJson } from "./store.mjs";

const PRIORITY_FILE = path.join(ROOT, "cache", "groq_priority.json");
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min in-memory TTL
const EVAL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours before re-evaluating known models

let cachedModels = null;
let modelsFetchedAt = 0;
const cooldowns = new Map(); // modelId -> cooldownUntil timestamp

export function resolveApiKey(requestKey) {
  if (requestKey) return requestKey;
  return process.env.GROQ_API_KEY || null;
}

export function isAvailable(requestKey) {
  return Boolean(resolveApiKey(requestKey));
}

export function bustCache() {
  cachedModels = null;
  modelsFetchedAt = 0;
  cooldowns.clear();
}

// Filter out non-chat models (audio, moderation, embeddings, Arabic-specific, etc.)
const EXCLUDED_PATTERNS = [
  /whisper/i,
  /prompt-guard/i,
  /safeguard/i,
  /orpheus/i,
  /vision/i,
  /audio/i,
  /embed/i,
  /allam/i,
];

// Live telemetry state tracked automatically from Groq HTTP headers
const liveLimits = {
  limitRequests: 1000,
  remainingRequests: null,
  limitTokens: 8000,
  remainingTokens: null,
  resetTokens: null,
  resetRequests: null,
  updatedAt: 0,
};

export function getLiveLimits() {
  return liveLimits.remainingRequests !== null ? liveLimits : null;
}

export function updateLiveLimits(headers) {
  if (!headers) return;
  const remReq = headers.get("x-ratelimit-remaining-requests");
  const limReq = headers.get("x-ratelimit-limit-requests");
  const remTok = headers.get("x-ratelimit-remaining-tokens");
  const limTok = headers.get("x-ratelimit-limit-tokens");
  const resTok = headers.get("x-ratelimit-reset-tokens");
  const resReq = headers.get("x-ratelimit-reset-requests");

  if (limReq) liveLimits.limitRequests = parseInt(limReq, 10);
  if (remReq) liveLimits.remainingRequests = parseInt(remReq, 10);
  if (limTok) liveLimits.limitTokens = parseInt(limTok, 10);
  if (remTok) liveLimits.remainingTokens = parseInt(remTok, 10);
  if (resTok) liveLimits.resetTokens = resTok;
  if (resReq) liveLimits.resetRequests = resReq;
  liveLimits.updatedAt = Date.now();
}

/**
 * Return safe pacing delay between consecutive requests based on model rate limits.
 * In Auto mode with active model juggling, allows fast 1.5s bursts: if a model hits
 * a rate limit, the engine instantly juggles to the next model without interruption.
 */
export function getSafeDelayMs(model) {
  const modelId = typeof model === "string" ? model : model?.id || "";
  const isAuto = !modelId || modelId === "groq/auto" || modelId === "auto";

  // In Auto mode, inspect which candidate will handle the next batch
  const activeModelId = isAuto ? getActiveModelId() : modelId;

  // Check if live telemetry remaining tokens are dangerously low (< 500)
  if (liveLimits.remainingTokens !== null && liveLimits.remainingTokens < 500) {
    if (liveLimits.resetTokens) {
      const match = String(liveLimits.resetTokens).match(/([\d.]+)s?/);
      if (match) return Math.min(8000, Math.ceil(parseFloat(match[1]) * 1000) + 400);
    }
    return 2000;
  }

  // If the active model is Qwen:
  if (activeModelId.includes("qwen")) {
    // In Auto mode with dynamic juggling, use 1.5s delay for ultra-fast bursts:
    // when Qwen reaches 1,000 OTPM, Auto seamlessly juggles to GPT-OSS 120B without stopping.
    // If locked to Qwen specifically, keep 6.5s delay to stay within 1,000 OTPM.
    return isAuto ? 1500 : 6500;
  }

  // Non-OTPM bottleneck models (e.g. gpt-oss-120b, Llama, etc.)
  return 800;
}

/**
 * Get the currently active model ID in Auto mode (skips models in cooldown).
 */
export function getActiveModelId() {
  const candidates = getCandidateModels("groq/auto");
  return candidates[0] || getBestModelId() || "qwen/qwen3.8-27b";
}

/**
 * Load the persistently saved priority list from disk.
 */
function loadSavedPriority() {
  return readJson(PRIORITY_FILE, {
    updatedAt: 0,
    bestModelId: null,
    priority: [],
  });
}

/**
 * Save the ranked priority list to disk.
 */
function savePriority(data) {
  writeJson(PRIORITY_FILE, {
    updatedAt: Date.now(),
    bestModelId: data.bestModelId,
    priority: data.priority,
  });
}

/**
 * Dynamically evaluate a live model with a quick translation probe.
 * Measures response latency and verifies real English translation without pinyin or reasoning leaks.
 */
async function probeModel(modelId, apiKey) {
  const t0 = Date.now();
  const isReasoning = modelId.includes("gpt-oss");
  const max_tokens = isReasoning ? 1500 : 350;
  try {
    const payload = {
      model: modelId,
      messages: [{ role: "user", content: "Translate to English: 忽睁睛抬头观看。那里得半点云彩？" }],
      max_tokens,
      temperature: 0.1,
    };
    if (isReasoning) {
      payload.reasoning_effort = "low";
    }
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    updateLiveLimits(res.headers);
    const elapsed = Date.now() - t0;

    const limits = {
      limitRequests: parseInt(res.headers.get("x-ratelimit-limit-requests"), 10) || null,
      remainingRequests: parseInt(res.headers.get("x-ratelimit-remaining-requests"), 10) || null,
      limitTokens: parseInt(res.headers.get("x-ratelimit-limit-tokens"), 10) || null,
      remainingTokens: parseInt(res.headers.get("x-ratelimit-remaining-tokens"), 10) || null,
      resetTokens: res.headers.get("x-ratelimit-reset-tokens") || null,
      resetRequests: res.headers.get("x-ratelimit-reset-requests") || null,
    };

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let otpm = null;
      const m = errText.match(/OTPM\s*\)?:\s*Limit\s*(\d+)/i) || errText.match(/output tokens per minute.*?Limit\s*(\d+)/i);
      if (m) otpm = parseInt(m[1], 10);
      return { id: modelId, success: false, latencyMs: elapsed, error: `HTTP ${res.status}`, limits: { ...limits, otpm }, isReasoning };
    }

    const json = await res.json();
    let text = json.choices?.[0]?.message?.content?.trim() || "";
    if (!text && json.choices?.[0]?.message?.reasoning) {
      text = json.choices[0].message.reasoning;
    }

    text = text
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^translate\s*(to\s*english)?\s*[:：]\s*/i, "")
      .replace(/^english\s*translation\s*[:：]\s*/i, "")
      .replace(/^["'“”]|["'“”]$/g, "")
      .trim();

    // 1. Must not contain Chinese characters
    const hasChinese = /[\u4e00-\u9fff]/.test(text);
    // 2. Must not be pinyin transliteration (no accented vowels)
    const hasPinyin = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i.test(text);
    // 3. Must contain relevant English vocabulary from the sentence
    const hasTranslationKeywords = /\b(cloud|clouds|eyes|looked|gazed|sky|open|opened|suddenly|see|seen)\b/i.test(text);
    // 4. Must be non-empty English prose
    const isValid = !hasChinese && !hasPinyin && hasTranslationKeywords && text.length >= 8;

    return {
      id: modelId,
      success: isValid,
      latencyMs: elapsed,
      sample: text.slice(0, 50),
      evaluatedAt: Date.now(),
      limits,
      isReasoning,
    };
  } catch (err) {
    return {
      id: modelId,
      success: false,
      latencyMs: Date.now() - t0,
      error: err.message,
      isReasoning,
    };
  }
}

/**
 * Fetch live models from Groq API, dynamically evaluate newly added models,
 * rank them, and persist the priority order.
 */
export async function listModels(forceRefresh = false, requestKey = null) {
  const now = Date.now();
  if (!forceRefresh && cachedModels && now - modelsFetchedAt < CACHE_TTL_MS) {
    return cachedModels;
  }

  const apiKey = resolveApiKey(requestKey);
  const saved = loadSavedPriority();

  // If no API key is configured yet, return whatever was previously saved or a placeholder
  if (!apiKey) {
    const bestId = saved.bestModelId || "groq/auto";
    return [
      {
        providerID: "groq",
        id: "groq/auto",
        name: `Groq Auto (${bestId})`,
        free: true,
      },
    ];
  }

  let fetched = [];
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      fetched = data?.data || [];
    }
  } catch (err) {
    console.warn("Failed to fetch Groq models dynamically:", err.message);
  }

  // Filter out non-chat models
  const chatCandidates = fetched.filter((m) => {
    if (m.active === false) return false;
    for (const pat of EXCLUDED_PATTERNS) {
      if (pat.test(m.id)) return false;
    }
    return true;
  });

  // Check which models are new or need evaluation
  const evaluatedMap = new Map((saved.priority || []).map((p) => [p.id, p]));
  let hasChanges = false;
  const evaluated = [];

  for (const m of chatCandidates) {
    const existing = evaluatedMap.get(m.id);
    const isStale = forceRefresh || !existing || now - (existing.evaluatedAt || 0) > EVAL_TTL_MS;
    if (isStale) {
      hasChanges = true;
      const result = await probeModel(m.id, apiKey);
      evaluated.push({
        id: m.id,
        contextLength: m.context_window || 131072,
        success: result.success,
        latencyMs: result.latencyMs,
        sample: result.sample || "",
        evaluatedAt: now,
        limits: result.limits || null,
        isReasoning: result.isReasoning || false,
      });
      await sleep(500);
    } else {
      evaluated.push({
        ...existing,
        contextLength: m.context_window || existing.contextLength || 131072,
      });
    }
  }

  // Sort by priority: successful models first, then fastest latency
  evaluated.sort((a, b) => {
    if (a.success !== b.success) return b.success ? 1 : -1;
    return (a.latencyMs || 9999) - (b.latencyMs || 9999);
  });

  const bestModelId = evaluated.find((m) => m.success)?.id || evaluated[0]?.id || null;

  // Persist the evaluated priority to disk
  if (hasChanges || !saved.bestModelId) {
    savePriority({ bestModelId, priority: evaluated });
  }

  // Build client-facing model list
  const mapped = [];
  const bestEntry = evaluated.find((m) => m.id === bestModelId);
  const activeId = getActiveModelId();

  mapped.push({
    providerID: "groq",
    id: "groq/auto",
    name: `⚡ Auto (Zero-Interruption Model Juggle · Active: ${activeId})`,
    contextLength: bestEntry?.contextLength || 131072,
    free: true,
    isReasoning: bestEntry?.isReasoning || false,
    latencyMs: bestEntry?.latencyMs || 0,
    limits: bestEntry?.limits || null,
  });

  for (const m of evaluated) {
    const speedStr = m.latencyMs ? ` · ~${m.latencyMs}ms` : "";
    const limitTag = m.id.includes("qwen") ? " · 1k OTPM" : (m.limits?.limitTokens ? ` · ${Math.round(m.limits.limitTokens / 1000)}k TPM` : "");
    const reasoningTag = m.isReasoning ? " · Reasoning" : "";
    mapped.push({
      providerID: "groq",
      id: m.id,
      name: `${m.id}${speedStr}${limitTag}${reasoningTag}`,
      contextLength: m.contextLength || 131072,
      free: true,
      success: m.success,
      latencyMs: m.latencyMs,
      limits: m.limits,
      isReasoning: m.isReasoning,
    });
  }

  cachedModels = mapped;
  modelsFetchedAt = now;
  return mapped;
}

/**
 * Get the currently designated best model ID from the saved priority cache.
 */
export function getBestModelId() {
  const saved = loadSavedPriority();
  if (saved.bestModelId) return saved.bestModelId;
  const firstActive = (saved.priority || []).find((p) => p.success);
  return firstActive?.id || null;
}

/**
 * Return ordered candidate model IDs according to the saved priority list.
 * In Auto mode, models currently cooling down from a 429 are placed behind ready models,
 * allowing instant juggling between models with zero interruption.
 */
export function getCandidateModels(preferredModelId) {
  const saved = loadSavedPriority();
  const known = ["qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"];
  const priorityList = (saved.priority || [])
    .filter((p) => p.success)
    .map((p) => p.id);
  for (const k of known) {
    if (!priorityList.includes(k)) priorityList.push(k);
  }

  const isAuto = !preferredModelId || preferredModelId === "groq/auto" || preferredModelId === "auto";
  const now = Date.now();
  const candidates = [];

  if (isAuto) {
    // In Auto juggle mode: prioritize models that are NOT currently cooling down
    for (const id of priorityList) {
      const coolUntil = cooldowns.get(id) || 0;
      if (now >= coolUntil) {
        candidates.push(id);
      }
    }
    // If all models are in cooldown, include all sorted by who exits cooldown earliest
    if (!candidates.length && priorityList.length) {
      const sorted = [...priorityList].sort((a, b) => (cooldowns.get(a) || 0) - (cooldowns.get(b) || 0));
      candidates.push(...sorted);
    }
  } else {
    // A specific model was requested: try it first
    candidates.push(preferredModelId);
    // Then add healthy fallbacks in case it fails or rate limits
    for (const id of priorityList) {
      if (id !== preferredModelId) {
        const coolUntil = cooldowns.get(id) || 0;
        if (now >= coolUntil) {
          candidates.push(id);
        }
      }
    }
  }

  return candidates.length ? candidates : known;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Generate text using Groq with automatic model juggling and fallback.
 */
export async function generate(
  prompt,
  { model, timeout = 25000, temperature = 0.2, apiKey: requestKey = null, maxTokens = null } = {},
) {
  const apiKey = resolveApiKey(requestKey);
  if (!apiKey) {
    throw new Error(
      "Groq API key is missing. Add it in Settings → Groq API key, or set GROQ_API_KEY in .env on the server."
    );
  }

  if (!cachedModels) {
    await listModels(false, requestKey).catch(() => {});
  }

  const requestedId = typeof model === "string" ? model : model?.id || "groq/auto";
  const pool = getCandidateModels(requestedId);

  let lastError = null;
  const maxAttempts = 6;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const now = Date.now();

    // 1. Find a candidate in the pool that is ready right now (not cooling down)
    let candidateId = pool.find((id) => (cooldowns.get(id) || 0) <= now);

    // 2. If ALL models in the pool are cooling down:
    if (!candidateId) {
      // Find the model with the shortest remaining cooldown
      let minRemainingMs = 45000;
      let earliestModel = pool[0];
      for (const id of pool) {
        const remaining = (cooldowns.get(id) || 0) - now;
        if (remaining > 0 && remaining < minRemainingMs) {
          minRemainingMs = remaining;
          earliestModel = id;
        }
      }
      // Cap pause to max 4.5 seconds so we never stall the reader
      const waitTime = Math.max(600, Math.min(minRemainingMs + 100, 4500));
      console.log(`⏳ Auto Juggle: All candidate models briefly cooling. Shortest wait is [${earliestModel}] (${(waitTime / 1000).toFixed(1)}s). Pausing...`);
      await sleep(waitTime);
      candidateId = earliestModel;
    }

    const isReasoning = candidateId.includes("gpt-oss");
    const tokenLimit = isReasoning ? 2000 : 800;
    const computedMaxTokens = maxTokens || Math.min(tokenLimit, Math.max(250, Math.ceil(prompt.length * 1.5)));

    const payload = {
      model: candidateId,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: computedMaxTokens,
    };
    if (isReasoning) {
      payload.reasoning_effort = "low";
    }

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });

      updateLiveLimits(res.headers);

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        let errorJson;
        try {
          errorJson = JSON.parse(errorText);
        } catch {
          errorJson = {};
        }
        const errorMsg = errorJson?.error?.message || errorText || `HTTP ${res.status}`;

        // If invalid key or unauthorized, fail immediately
        if (res.status === 401 || /invalid api key/i.test(errorMsg)) {
          throw new Error(`Groq: ${errorMsg}`);
        }

        // On 429 rate limit (OTPM or requests limit)
        if (res.status === 429) {
          const msgMatch = errorMsg.match(/try again in ([\d.]+)s/i);
          let waitMs = 4000;
          if (msgMatch) {
            waitMs = Math.ceil(parseFloat(msgMatch[1]) * 1000) + 800;
          } else {
            const resetTokens = res.headers.get("x-ratelimit-reset-tokens");
            const retryAfter = res.headers.get("retry-after");
            if (resetTokens) {
              const match = resetTokens.match(/([\d.]+)s?/);
              if (match) waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 800;
            } else if (retryAfter) {
              waitMs = Math.ceil(parseFloat(retryAfter) * 1000) + 800;
            }
          }
          // Set cooldown on this candidate so subsequent attempts bypass it
          cooldowns.set(candidateId, Date.now() + Math.min(45000, waitMs));

          // Find another ready model across the entire pool
          const nextReady = pool.find((id) => id !== candidateId && (cooldowns.get(id) || 0) <= Date.now());
          if (nextReady) {
            console.log(`⚡ Auto Juggle: [${candidateId}] rate limited (cooling for ${Math.round(waitMs / 1000)}s). Instantly juggling to [${nextReady}] for zero interruption!`);
            continue;
          }

          // If no other model is ready right now, find the shortest cooldown among OTHER models
          const otherRemaining = pool
            .filter((id) => id !== candidateId)
            .map((id) => Math.max(0, (cooldowns.get(id) || 0) - Date.now()));
          const shortestOther = otherRemaining.length ? Math.min(...otherRemaining) : waitMs;
          const briefWait = Math.max(600, Math.min(shortestOther + 150, 4500));
          console.warn(`Groq [${candidateId}] rate limited. Next model available in ${(briefWait / 1000).toFixed(1)}s. Pausing...`);
          await sleep(briefWait);
          continue;
        }

        // Non-429 error (e.g. 500, 503)
        cooldowns.set(candidateId, Date.now() + 25000);
        lastError = new Error(`Groq [${candidateId}] HTTP ${res.status}: ${errorMsg}`);
        console.warn(`Groq model ${candidateId} failed (HTTP ${res.status}). Trying next candidate...`);
        await sleep(300);
        continue;
      }

      const json = await res.json();
      let content = json.choices?.[0]?.message?.content || "";
      // Strip internal thinking/reasoning tags if generated by reasoning models
      content = content
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
        .trim();

      if (!content) {
        cooldowns.set(candidateId, Date.now() + 25000);
        throw new Error(`Groq model ${candidateId} returned empty response`);
      }

      return content;
    } catch (err) {
      if (err.message.startsWith("Groq: Invalid") || err.message.includes("401")) {
        throw err;
      }
      lastError = err;
      cooldowns.set(candidateId, Date.now() + 25000);
      console.warn(`Groq model ${candidateId} error: ${err.message}. Trying next priority fallback...`);
      await sleep(300);
    }
  }

  throw lastError || new Error("All Groq candidate models failed");
}

/**
 * Validate a Groq API key and check available model count.
 */
export async function checkKey(requestKey) {
  const apiKey = resolveApiKey(requestKey);
  if (!apiKey) return { valid: false, error: "Missing API key" };
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { valid: false, error: err.error?.message || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return {
      valid: true,
      modelCount: data.data?.length || 0,
      limits: getLiveLimits(),
    };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}
