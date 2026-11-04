import fs from "node:fs";
import path from "node:path";
import { ROOT, readJson, writeJson } from "./store.mjs";

const METRICS_FILE = path.join(ROOT, "cache", "metrics.json");

const defaultMetrics = {
  translation_cache_hit: 0,
  translation_cache_miss: 0,
  source_cache_hit: 0,
  source_cache_miss: 0,
  embedding_cache_hit: 0,
  embedding_cache_miss: 0,
  recommendation_cache_hit: 0,
  recommendation_cache_miss: 0,
  tokens_saved: 0,
  translation_tokens_used: 0,
  startedAt: Date.now(),
  lastUpdated: Date.now(),
};

class MetricsTracker {
  constructor() {
    this.data = { ...defaultMetrics, ...(readJson(METRICS_FILE, {}) || {}) };
    this._saveTimer = null;
  }

  record(key, amount = 1) {
    if (typeof this.data[key] === "number") {
      this.data[key] += amount;
    } else {
      this.data[key] = amount;
    }
    this.data.lastUpdated = Date.now();
    this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        writeJson(METRICS_FILE, this.data);
      } catch {
        /* ignore */
      }
    }, 2000);
  }

  getStats() {
    const totalTrans = this.data.translation_cache_hit + this.data.translation_cache_miss;
    const transHitRate = totalTrans > 0 ? Number(((this.data.translation_cache_hit / totalTrans) * 100).toFixed(1)) : 0;

    const totalSource = this.data.source_cache_hit + this.data.source_cache_miss;
    const sourceHitRate = totalSource > 0 ? Number(((this.data.source_cache_hit / totalSource) * 100).toFixed(1)) : 0;

    return {
      ...this.data,
      rates: {
        translationHitRate: `${transHitRate}%`,
        sourceHitRate: `${sourceHitRate}%`,
      },
    };
  }
}

export const metrics = new MetricsTracker();
