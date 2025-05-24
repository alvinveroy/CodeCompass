#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import NodeCache from 'node-cache';
// Do not import configService or startServer here yet if we need to set process.env first.

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
    const packageJson = JSON.parse(packageJsonContent) as { version?: string };
    return packageJson.version || 'unknown';
  } catch {
    // Silently return 'unknown' on error, e.g. if package.json is not found during certain build phases
    return 'unknown';
  }
}

function displayHelp() {
  const version = getPackageVersion();
  console.log(`
CodeCompass CLI (version ${version})

Usage: codecompass [options] [command|repoPath]

Description:
  AI-powered MCP server for codebase navigation and LLM prompt optimization.
  If no command is provided, the server starts with the specified or default repoPath.

Options:
  --port <number>     Specify the HTTP port for the server. Overrides HTTP_PORT env var.

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
                               codecompass --port 3005 /path/to/repo

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
        // Future verbose-specific logic
      }
      return;
    }

    const changelogContent = fs.readFileSync(changelogPath, 'utf8');
    changelogCache.set(CACHE_KEY_CONTENT, changelogContent);
    changelogCache.set(CACHE_KEY_MTIME, currentMtime);
    
    console.log(changelogContent);
    if (verbose) {
      // Future verbose-specific logic
    }
  } catch (error) {
    console.error('Error reading or caching CHANGELOG.md:', error);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let repoPath = ".";
  let portOverride: string | undefined;

  // Parse arguments
  const remainingArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port') {
      if (i + 1 < args.length) {
        portOverride = args[i + 1];
        i++; // Skip next argument as it's the port value
      } else {
        console.error('Error: --port option requires a value.');
        displayHelp();
        process.exit(1);
      }
    } else {
      remainingArgs.push(arg);
    }
  }

  if (portOverride) {
    const portNum = parseInt(portOverride, 10);
    if (isNaN(portNum) || portNum <= 0 || portNum > 65535) {
      console.error(`Error: Invalid port number "${portOverride}". Port must be between 1 and 65535.`);
      process.exit(1);
    }
    process.env.HTTP_PORT = portOverride; // Set env var before ConfigService is loaded
    console.log(`Attempting to use port: ${portOverride} (from --port flag)`);
  }

  // Now that process.env.HTTP_PORT might be set, we can import modules that use ConfigService.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startServer, ServerStartupError } = require('./lib/server') as typeof import('./lib/server');

  const primaryArg = remainingArgs[0];
  const secondaryArg = remainingArgs[1]; // For flags like --changelog --verbose

  if (primaryArg === '--help' || primaryArg === '-h') {
    displayHelp();
    process.exit(0);
  } else if (primaryArg === '--version' || primaryArg === '-v') {
    console.log(getPackageVersion());
    process.exit(0);
  } else if (primaryArg === '--changelog') {
    const verbose = secondaryArg === '--verbose';
    displayChangelog(verbose);
    process.exit(0);
  } else {
    if (primaryArg && !primaryArg.startsWith('--')) {
      repoPath = primaryArg;
    } else if (primaryArg && primaryArg.startsWith('--')) {
      console.warn(`Warning: Unrecognized flag "${primaryArg}" after --port processing. Starting server with default repository path "${repoPath}".`);
      console.warn(`Run 'codecompass --help' for available commands.`);
    }

    try {
      await startServer(repoPath);
    } catch (error: unknown) {
      if (error instanceof ServerStartupError) {
        if (error.exitCode !== 0) {
          console.error(`CodeCompass server failed to start. Error: ${error.message}`);
        }
        // For exitCode 0, startServer already logged info about existing instance.
        process.exit(error.exitCode);
      } else {
        console.error('An unexpected error occurred during server startup:', error);
        process.exit(1);
      }
    }
  }
}

main().catch(error => {
  console.error('Critical error in CLI execution:', error);
  process.exit(1);
});
