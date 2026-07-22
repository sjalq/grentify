/**
 * Volume catalog detection for ecosystem suite budgets.
 *
 * Same thresholds as Port.Volume (src/Port/Volume.gren):
 *   maxModuleBytes >= 100_000  OR  modules >= 200  OR  totalBytes >= 250_000
 *
 * Used for adaptive timeouts and scale-vs-timeout classification.
 */
const fs = require("node:fs");
const path = require("node:path");

const THRESHOLDS = {
  maxModuleBytes: 100_000,
  modules: 200,
  // 250k: gate v5c found iso3166 (326k across ~25 flat lookup-table
  // modules) aggregate-slow but under every threshold; the tables
  // class needs the volume budget, not the 120s cap.
  totalBytes: 250_000,
};

/** @typedef {{ modules: number, totalBytes: number, maxModuleBytes: number, volume: boolean, summary: string }} VolumeMetrics */

/**
 * @param {string} rootDir package root (contains src/ or .elm files)
 * @returns {VolumeMetrics}
 */
function scanPackageDirectory(rootDir) {
  const empty = {
    modules: 0,
    totalBytes: 0,
    maxModuleBytes: 0,
    volume: false,
    summary: "0 modules, 0 bytes",
  };
  if (!rootDir || !fs.existsSync(rootDir)) {
    return empty;
  }
  const src = path.join(rootDir, "src");
  const walkRoot = fs.existsSync(src) ? src : rootDir;
  let modules = 0;
  let totalBytes = 0;
  let maxModuleBytes = 0;
  walk(walkRoot, (file, size) => {
    if (file.endsWith(".elm") || file.endsWith(".gren")) {
      modules += 1;
      totalBytes += size;
      if (size > maxModuleBytes) maxModuleBytes = size;
    }
  });
  const volume = isVolume({ modules, totalBytes, maxModuleBytes });
  return {
    modules,
    totalBytes,
    maxModuleBytes,
    volume,
    summary: `${modules} modules, ${totalBytes} bytes, max ${maxModuleBytes}`,
  };
}

/**
 * Locate acquired source under registry cache for author/name@version.
 * @param {string} cacheDir
 * @param {string} name author/name
 * @param {string} [version]
 * @returns {string|null}
 */
function findCachedPackageRoot(cacheDir, name, version) {
  if (!cacheDir || !name) return null;
  const base = path.join(
    cacheDir,
    "registry",
    "packages",
    ...name.split("/"),
    version || "",
  );
  if (!version || !fs.existsSync(base)) {
    // try without version or latest source-*
    const pkgDir = path.join(cacheDir, "registry", "packages", ...name.split("/"));
    if (!fs.existsSync(pkgDir)) return null;
    if (version) {
      const vdir = path.join(pkgDir, version);
      if (!fs.existsSync(vdir)) return null;
      return findSourceRoot(vdir);
    }
    return null;
  }
  return findSourceRoot(base);
}

function findSourceRoot(versionDir) {
  // Prefer directory with elm.json + most .elm under src/ (skip showcase/tests).
  let best = null;
  let bestScore = -1;
  walkDirs(versionDir, (dir) => {
    const base = path.basename(dir);
    if (base === "showcase" || base === "tests" || base === "examples") {
      return;
    }
    const src = path.join(dir, "src");
    const elmJson = path.join(dir, "elm.json");
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return;
    let score = 0;
    if (fs.existsSync(elmJson)) score += 10000;
    walk(src, (file) => {
      if (file.endsWith(".elm")) score += 1;
    });
    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }, 5);
  return best;
}

/**
 * @param {{ modules: number, totalBytes: number, maxModuleBytes: number }} m
 */
function isVolume(m) {
  return (
    m.maxModuleBytes >= THRESHOLDS.maxModuleBytes ||
    m.modules >= THRESHOLDS.modules ||
    m.totalBytes >= THRESHOLDS.totalBytes
  );
}

/**
 * Adaptive per-package timeout (ms).
 * base + 20s per 100KB total + 0.5s per module, capped.
 * Volume packages get a higher floor so real scale work finishes.
 *
 * @param {VolumeMetrics|null} metrics
 * @param {number} baseTimeoutMs suite default
 */
function adaptiveTimeoutMs(metrics, baseTimeoutMs) {
  const base = Number.isFinite(baseTimeoutMs) && baseTimeoutMs > 0 ? baseTimeoutMs : 120000;
  if (!metrics || !metrics.volume) {
    return base;
  }
  // Extract+transform dominates (format already skipped for volume). Measured:
  // feather ~400–460s, ionicons >480s, ant-design ~789 modules even heavier.
  const fromSize =
    120_000 +
    Math.ceil(metrics.totalBytes / 100_000) * 25_000 +
    metrics.modules * 800;
  // Floor 12 min so one-shot megamodules finish; cap 25 min.
  const volumeBudget = Math.min(25 * 60_000, Math.max(12 * 60_000, fromSize));
  return Math.max(base, volumeBudget);
}

/**
 * Classify a timeout as scale or hang, based on volume classification.
 *
 * Decision table (only volume packages may be "scale"):
 * - NOT timedOut               => return "timeout"
 * - timedOut AND volume        => return "scale"
 * - timedOut AND NOT volume    => return "hang" (regardless of budgetMs)
 *
 * @param {boolean} timedOut
 * @param {VolumeMetrics|null} metrics
 * @param {number} budgetMs (unused; budget size never excuses a non-volume timeout)
 * @returns {"timeout"|"scale"|"hang"}
 */
function classifyTimeout(timedOut, metrics, budgetMs) {
  if (!timedOut) return "timeout";
  if (metrics && metrics.volume) return "scale";
  return "hang";
}

function walk(dir, onFile, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "elm-stuff" || e.name === ".git") {
      continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, onFile, depth + 1);
    else if (e.isFile()) {
      try {
        onFile(full, fs.statSync(full).size);
      } catch {
        /* ignore */
      }
    }
  }
}

function walkDirs(dir, onDir, maxDepth, depth = 0) {
  if (depth > maxDepth) return;
  onDir(dir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === "node_modules" || e.name === "elm-stuff") continue;
    walkDirs(path.join(dir, e.name), onDir, maxDepth, depth + 1);
  }
}

module.exports = {
  THRESHOLDS,
  scanPackageDirectory,
  findCachedPackageRoot,
  isVolume,
  adaptiveTimeoutMs,
  classifyTimeout,
};
