#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';
import { startServer } from './lib/server';

// Initialize cache: stdTTL is 0 (infinite) as we manage staleness via file mtime
// checkOnPreviousTTL: false, as we don't use individual item TTLs here.
const changelogCache = new NodeCache({ stdTTL: 0, checkperiod: 0 });
const CACHE_KEY_CONTENT = 'changelogContent';
const CACHE_KEY_MTIME = 'changelogMtime';

// Helper function to read package.json version
function getPackageVersion(): string {
  try {
    // Assuming the script runs from dist/index.js, package.json is ../package.json
    const packageJsonPath = path.resolve(__dirname, '../package.json');
    const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);
    return packageJson.version || 'unknown';
  } catch (_error) {
    // Silently return 'unknown' on error, e.g. if package.json is not found during certain build phases
    return 'unknown';
  }
}

function displayHelp() {
  const version = getPackageVersion();
  console.log(`
CodeCompass CLI (version ${version})

Usage: codecompass [command|repoPath]

Description:
  AI-powered MCP server for codebase navigation and LLM prompt optimization.
  If no command is provided, the server starts with the specified or default repoPath.

Commands:
  --help, -h          Show this help message and exit.
  --version, -v       Show version information and exit.
  --changelog         Show the project changelog and exit.
                      Supports an optional --verbose flag (e.g., codecompass --changelog --verbose)
                      for potentially more detailed output in the future.

Arguments:
  repoPath (optional) Path to the repository to be analyzed by the server.
                      Defaults to the current directory ('.') if not specified.
                      Example: codecompass /path/to/your/repo
                               codecompass .
                               codecompass

For more information, visit: https://github.com/alvinveroy/codecompass
`);
}

function displayChangelog(verbose: boolean) {
  const changelogPath = path.resolve(__dirname, '../CHANGELOG.md');
  try {
    const stats = fs.statSync(changelogPath);
    const currentMtime = stats.mtimeMs;

    const cachedMtime = changelogCache.get<number>(CACHE_KEY_MTIME);
    const cachedContent = changelogCache.get<string>(CACHE_KEY_CONTENT);

    if (cachedContent && cachedMtime && cachedMtime === currentMtime) {
      console.log(cachedContent);
      if (verbose) {
        // console.log("\n[Verbose changelog mode active - served from cache]");
      }
      return;
    }

    // Cache is stale or doesn't exist, read file
    const changelogContent = fs.readFileSync(changelogPath, 'utf8');
    changelogCache.set(CACHE_KEY_CONTENT, changelogContent);
    changelogCache.set(CACHE_KEY_MTIME, currentMtime);
    
    console.log(changelogContent);
    if (verbose) {
      // Placeholder for future verbose-specific logic.
      // For now, verbose output is the same as non-verbose for the full changelog.
      // console.log("\n[Verbose changelog mode active - freshly read]");
    }
  } catch (error) {
    console.error('Error reading or caching CHANGELOG.md:', error);
  }
}

const primaryArg = process.argv[2];
const secondaryArg = process.argv[3]; // Used for flags like --changelog --verbose

if (primaryArg === '--help' || primaryArg === '-h') {
  displayHelp();
} else if (primaryArg === '--version' || primaryArg === '-v') {
  console.log(getPackageVersion());
} else if (primaryArg === '--changelog') {
  const verbose = secondaryArg === '--verbose';
  displayChangelog(verbose);
} else {
  // Default behavior: start the server.
  // Determine repoPath: use primaryArg if it exists and doesn't start with '--', otherwise default to '.'.
  let repoPath = ".";
  if (primaryArg && !primaryArg.startsWith('--')) {
    repoPath = primaryArg;
  } else if (primaryArg && primaryArg.startsWith('--')) {
    // An unrecognized flag was passed as primaryArg.
    // The server will start with the default repoPath '.'.
    console.warn(`Warning: Unrecognized flag "${primaryArg}". Starting server with default repository path "${repoPath}".`);
    console.warn(`Run 'codecompass --help' for available commands.`);
  }
  // If primaryArg is undefined (no arguments given), repoPath remains '.'.

  startServer(repoPath);
}
