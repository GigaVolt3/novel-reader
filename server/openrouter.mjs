import { ROOT, readJson } from "./store.mjs";
import path from "node:path";

let cachedModels = null;
let modelsFetchedAt = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const cooldowns = new Map(); // modelId -> cooldownUntil timestamp

/** Clear the in-memory model list cache (call after API key change). */
export function bustCache() {
  cachedModels = null;
  modelsFetchedAt = 0;
  cooldowns.clear();
}

/**
 * Check OpenRouter key quota & usage (free tier remaining requests).
 */
export async function checkKeyLimits(requestKey = null) {
  const apiKey = resolveApiKey(requestKey);
  if (!apiKey) return { available: false, error: "No API key" };
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    const data = json?.data || {};
    const freeReqs = data?.free_model_daily_requests || null;
    return {
      available: true,
      label: data.label || null,
      isFreeTier: data.is_free_tier ?? true,
      freeDaily: freeReqs ? {
        used: freeReqs.used ?? 0,
        limit: freeReqs.limit ?? 50,
        remaining: freeReqs.remaining ?? 0,
      } : null,
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

/**
 * Resolve the API key to use for a request.
 * Priority: requestKey (from X-OpenRouter-Key header from browser) → process.env.OPENROUTER_API_KEY
 */
export function resolveApiKey(requestKey) {
  if (requestKey) return requestKey;
  return process.env.OPENROUTER_API_KEY || null;
}

/** Returns true if a server-side key is available in .env. */
export function getApiKey() {
  return resolveApiKey(null);
}

export function isAvailable(requestKey) {
  return Boolean(resolveApiKey(requestKey));
}

const EXCLUDED_PATTERNS = [
  /-vl\b/i,
  /safety/i,
  /audio/i,
  /clip/i,
  /lyria/i,
  /whisper/i,
  /embed/i,
  /code\b/i,
  /dots-3-note/i,
];

/**
 * Fetch free models from OpenRouter dynamically.
 * Auto-discovers new free models as OpenRouter updates them.
 * @param {boolean} forceRefresh
 * @param {string|null} requestKey  Per-request API key from the browser header
 */
export async function listFreeModels(forceRefresh = false, requestKey = null) {
  const now = Date.now();
  if (!forceRefresh && cachedModels && now - modelsFetchedAt < CACHE_TTL_MS) {
    return cachedModels;
  }

  const apiKey = resolveApiKey(requestKey);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let fetched = [];
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      fetched = data?.data || [];
    }
  } catch (err) {
    console.warn("Failed to fetch OpenRouter models dynamically:", err.message);
  }

  // Filter free models
  const free = fetched.filter((m) => {
    const isZeroPrice = m.pricing?.prompt === "0" && m.pricing?.completion === "0";
    const isFree = m.id.endsWith(":free") || isZeroPrice || m.id === "openrouter/free";
    if (!isFree) return false;
    for (const pat of EXCLUDED_PATTERNS) {
      if (pat.test(m.id)) return false;
    }
    return true;
  });

  const priorityOrder = [
    "openrouter/free",
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "liquid/lfm-2.5-2.6b:free",
  ];

  const sortedFree = [...free].sort((a, b) => {
    const aIdx = priorityOrder.indexOf(a.id);
    const bIdx = priorityOrder.indexOf(b.id);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return (b.context_length || 0) - (a.context_length || 0);
  });

  const mapped = [];

  // Always offer openrouter/free first
  mapped.push({
    providerID: "openrouter",
    id: "openrouter/free",
    name: "⚡ Auto (Zero-Interruption Free Models Juggle)",
    contextLength: 200000,
    free: true,
  });

  for (const m of sortedFree) {
    if (m.id === "openrouter/free") continue;
    mapped.push({
      providerID: "openrouter",
      id: m.id,
      name: m.name || m.id,
      contextLength: m.context_length || 32768,
      free: true,
    });
  }

  cachedModels = mapped;
  modelsFetchedAt = now;
  return mapped;
}

function getCandidateModels(preferredModelId) {
  const now = Date.now();
  const all = (cachedModels || []).map((m) => m.id);
  if (!all.includes("openrouter/free")) all.unshift("openrouter/free");

  const isAuto = !preferredModelId || preferredModelId === "openrouter/free" || preferredModelId === "auto";
  const candidates = [];

  if (isAuto) {
    for (const id of all) {
      if (id === "openrouter/free") continue;
      const coolUntil = cooldowns.get(id) || 0;
      if (now >= coolUntil) {
        candidates.push(id);
      }
    }
    candidates.push("openrouter/free");
  } else {
    candidates.push(preferredModelId);
    for (const id of all) {
      if (id !== preferredModelId) {
        const coolUntil = cooldowns.get(id) || 0;
        if (now >= coolUntil) {
          candidates.push(id);
        }
      }
    }
  }

  if (candidates.length === 0) {
    return all.length ? all : ["openrouter/free"];
  }
  return candidates;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Generate text using OpenRouter with automatic model fallback.
 * @param {string} prompt
 * @param {{ model?, timeout?, temperature?, apiKey? }} options
 *   apiKey — per-request key from the browser header (overrides env/.secrets.json)
 */
export async function generate(prompt, { model, timeout = 22000, temperature = 0.2, apiKey: requestKey = null } = {}) {
  const apiKey = resolveApiKey(requestKey);
  if (!apiKey) {
    throw new Error(
      "OpenRouter API key is missing. Add it in Settings → OpenRouter API key, " +
      "or set OPENROUTER_API_KEY in the server environment."
    );
  }

  if (!cachedModels) {
    await listFreeModels(false, requestKey).catch(() => {});
  }

  const preferredId = typeof model === "string" ? model : model?.id || "openrouter/free";
  const candidates = getCandidateModels(preferredId);

  let lastError = null;

  for (let i = 0; i < Math.min(candidates.length, 5); i++) {
    const candidateId = candidates[i];
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:7777",
          "X-Title": "Novel Reader",
        },
        body: JSON.stringify({
          model: candidateId,
          messages: [{ role: "user", content: prompt }],
          temperature,
        }),
        signal: AbortSignal.timeout(timeout),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        let errorJson;
        try {
          errorJson = JSON.parse(errorText);
        } catch {
          errorJson = {};
        }
        const errorMsg = errorJson?.error?.message || errorText || `HTTP ${res.status}`;

        // Account-level quota / rate limits will fail across all models: bail immediately
        const isAccountLimit =
          res.status === 401 ||
          /free-models-per-day|daily-requests|credits|insufficient|unauthorized|invalid api key/i.test(errorMsg);
        if (isAccountLimit) {
          throw new Error(`OpenRouter: ${errorMsg}`);
        }

        // Cooldown for 2 minutes on rate limit or server error
        if (res.status === 429 || res.status >= 500) {
          cooldowns.set(candidateId, Date.now() + 2 * 60 * 1000);
        }

        lastError = new Error(`OpenRouter [${candidateId}] HTTP ${res.status}: ${errorMsg}`);
        console.warn(`OpenRouter model ${candidateId} failed (HTTP ${res.status}). Trying next free model...`);
        await sleep(Math.min(400 * (i + 1), 2000));
        continue;
      }

      const json = await res.json();
      let content = json.choices?.[0]?.message?.content || "";
      content = content
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
        .trim();
      if (!content) {
        cooldowns.set(candidateId, Date.now() + 2 * 60 * 1000);
        throw new Error(`OpenRouter model ${candidateId} returned empty response`);
      }

      return content;
    } catch (err) {
      lastError = err;
      cooldowns.set(candidateId, Date.now() + 2 * 60 * 1000);
      // Account-wide free quota exhausted: abort candidate loop immediately to trigger instant failover
      if (err.message && err.message.includes("free-models-per-day")) {
        throw err;
      }
      console.warn(`OpenRouter model ${candidateId} error: ${err.message}. Trying next fallback...`);
      await sleep(Math.min(600 * (i + 1), 3000));
    }
  }

  throw lastError || new Error("All OpenRouter candidate models failed");
}
