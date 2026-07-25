const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const lockRoot = path.join(os.tmpdir(), "elm-to-gren-add-locks");

function acquireForArgs(args, cwd = process.cwd()) {
  const applicationRoot = addApplicationRoot(args, cwd);
  if (applicationRoot === null) {
    return { release: null, error: null };
  }

  const digest = crypto
    .createHash("sha256")
    .update(applicationRoot)
    .digest("hex");
  const lockDirectory = path.join(lockRoot, digest);
  const ownerPath = path.join(lockDirectory, "owner.json");
  const token = crypto.randomUUID();

  fs.mkdirSync(lockRoot, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lockDirectory);
      fs.writeFileSync(
        ownerPath,
        `${JSON.stringify({
          pid: process.pid,
          token,
          applicationRoot,
          acquiredAt: new Date().toISOString(),
        })}\n`,
      );

      return {
        error: null,
        release() {
          releaseOwnedLock(lockDirectory, ownerPath, token);
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return {
          release: null,
          error: `ADD_LOCK_FAILED: Could not lock ${applicationRoot}: ${error.message}`,
        };
      }

      if (attempt === 0 && ownerIsDeadOrStale(lockDirectory, ownerPath)) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        continue;
      }

      return {
        release: null,
        error: `ADD_LOCKED: Another add is already modifying ${applicationRoot}.`,
      };
    }
  }

  return {
    release: null,
    error: `ADD_LOCKED: Another add is already modifying ${applicationRoot}.`,
  };
}

function addApplicationRoot(args, cwd) {
  if (args[0] !== "add") {
    return null;
  }

  let output = ".";
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--out" || argument === "-o") {
      if (index + 1 < args.length) {
        output = args[index + 1];
        index += 1;
      }
    } else if (argument.startsWith("--out=")) {
      output = argument.slice("--out=".length);
    }
  }

  return path.resolve(cwd, output);
}

function ownerIsDeadOrStale(lockDirectory, ownerPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH";
      }
    }
  } catch {
    try {
      const age = Date.now() - fs.statSync(lockDirectory).mtimeMs;
      return age > 60_000;
    } catch {
      return false;
    }
  }

  return false;
}

function releaseOwnedLock(lockDirectory, ownerPath, token) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.token === token) {
      fs.rmSync(lockDirectory, { recursive: true, force: true });
    }
  } catch {
    // A missing or replaced lock is no longer ours to release.
  }
}

module.exports = {
  acquireForArgs,
};
