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

Usage: codecompass [options] [command|repoPath] [tool_parameters_json]

Description:
  AI-powered MCP server for codebase navigation and LLM prompt optimization.
  If no command is provided, or if the first argument is a path, the server starts.
  If the first command is a recognized tool name, CodeCompass attempts to act as a client.

Options:
  --port <number>     Specify the HTTP port for the server. Overrides HTTP_PORT env var.

Server Commands:
  [repoPath]          Start the server with the specified or default repoPath.
                      Example: codecompass /path/to/your/repo
                               codecompass .
                               codecompass --port 3005 /path/to/repo

Client Commands (if a server is running on the configured port):
  agent_query <json_params>
                      Execute the 'agent_query' tool.
                      Example: codecompass agent_query '{"query": "How is auth handled?"}'
  bb7_search_code <json_params>
                      Execute the 'bb7_search_code' tool.
                      Example: codecompass bb7_search_code '{"query": "user login function"}'
  bb7_get_changelog   Execute the 'bb7_get_changelog' tool (no parameters).
  bb7_get_indexing_status
                      Execute the 'bb7_get_indexing_status' tool (no parameters).
  bb7_switch_suggestion_model <json_params>
                      Execute the 'bb7_switch_suggestion_model' tool.
                      Example: codecompass bb7_switch_suggestion_model '{"model": "deepseek-coder", "provider": "deepseek"}'
  bb7_get_session_history <json_params>
                      Execute the 'bb7_get_session_history' tool.
                      Example: codecompass bb7_get_session_history '{"sessionId": "some-id"}'
  bb7_generate_suggestion <json_params>
                      Execute the 'bb7_generate_suggestion' tool.
                      Example: codecompass bb7_generate_suggestion '{"query": "optimize this loop"}'
  bb7_get_repository_context <json_params>
                      Execute the 'bb7_get_repository_context' tool.
                      Example: codecompass bb7_get_repository_context '{"query": "main API components"}'


Other Commands:
  --help, -h          Show this help message and exit.
  --version, -v       Show version information and exit.
  --changelog         Show the project changelog and exit.
                      Supports an optional --verbose flag.

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

// List of known tools that can be called from the CLI
// This helps distinguish tool calls from repoPath arguments.
const KNOWN_TOOLS = [
  'agent_query',
  'bb7_search_code',
  'bb7_get_changelog',
  'bb7_get_indexing_status',
  'bb7_switch_suggestion_model',
  'bb7_get_session_history',
  'bb7_generate_suggestion',
  'bb7_get_repository_context',
  // Add other tools intended for CLI client execution here
];

async function executeClientCommand(toolName: string, toolParamsString?: string) {
  // Placeholder for client logic
  console.log(`CLI Client Mode: Attempting to execute tool '${toolName}'`);
  if (toolParamsString) {
    try {
      const params = JSON.parse(toolParamsString);
      console.log('With parameters:', params);
    } catch (e) {
      console.error(`Error: Invalid JSON parameters for tool ${toolName}: ${toolParamsString}`);
      console.error((e as Error).message);
      process.exit(1);
    }
  } else {
    console.log('With no parameters.');
  }
  // TODO:
  // 1. Import configService (dynamically, after env.HTTP_PORT is set if needed by client)
  // 2. Check if server is running on configService.HTTP_PORT (e.g., /api/ping)
  // 3. If running:
  //    a. Import MCP Client from SDK
  //    b. Create StreamableHTTPClientTransport
  //    c. Connect client
  //    d. Call client.callTool({ name: toolName, arguments: parsedParams })
  //    e. Print result
  //    f. Exit 0 on success, 1 on client/tool error
  // 4. If not running:
  //    a. console.error("CodeCompass server is not running. Please start it first.");
  //    b. process.exit(1);
  console.log("Client mode execution is not yet fully implemented.");
  process.exit(0); // Temporary exit for placeholder
}


async function main() {
  const args = process.argv.slice(2);
  let repoPath = ".";
  let portOverride: string | undefined;

  const remainingArgsForCommandProcessing: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port') {
      if (i + 1 < args.length) {
        portOverride = args[i + 1];
        i++; 
      } else {
        console.error('Error: --port option requires a value.');
        displayHelp();
        process.exit(1);
      }
    } else {
      remainingArgsForCommandProcessing.push(arg);
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

  const primaryArg = remainingArgsForCommandProcessing[0];
  const secondaryArg = remainingArgsForCommandProcessing[1]; 

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
  } else if (KNOWN_TOOLS.includes(primaryArg)) {
    // This is a client command execution
    const toolName = primaryArg;
    const toolParamsString = secondaryArg; // This is the JSON string of parameters
    // Any further args (remainingArgsForCommandProcessing[2] onwards) are currently ignored for client commands.
    await executeClientCommand(toolName, toolParamsString);
  } else {
    // Default behavior: start the server.
    // Now import server-related modules as we are in server mode or client mode needs them.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { startServer, ServerStartupError } = require('./lib/server') as typeof import('./lib/server');

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
