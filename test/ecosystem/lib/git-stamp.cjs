/**
 * Git identity for suite proofs. A proof is only valid for one exact tree.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return null;
  }
  return (result.stdout || "").trim();
}

/**
 * @param {string} root repo root
 * @returns {{
 *   commit: string,
 *   short: string,
 *   branch: string,
 *   dirty: boolean,
 *   subject: string,
 * }}
 */
function gitStamp(root) {
  const commit = runGit(root, ["rev-parse", "HEAD"]);
  if (!commit) {
    return {
      commit: "UNKNOWN",
      short: "UNKNOWN",
      branch: "UNKNOWN",
      dirty: true,
      subject: "not a git checkout",
    };
  }
  const short = runGit(root, ["rev-parse", "--short", "HEAD"]) || commit.slice(0, 7);
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || "DETACHED";
  const subject = runGit(root, ["log", "-1", "--pretty=%s"]) || "";
  const porcelain = runGit(root, ["status", "--porcelain"]) || "";
  return {
    commit,
    short,
    branch,
    dirty: porcelain.length > 0,
    subject,
  };
}

/**
 * Single canonical proof file. Never treat scattered .test-cache logs as success.
 */
function proofPath(root) {
  return path.join(root, ".test-cache", "ecosystem-proof", "LAST_RUN.json");
}

module.exports = { gitStamp, proofPath, runGit };
