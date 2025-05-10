# File: src/index.ts

## Purpose

This file serves as the main entry point for the CodeCompass Command Line Interface (CLI). It handles parsing command-line arguments and dispatching actions accordingly, such as displaying help information, version, changelog, or starting the MCP server.

## Key Responsibilities/Exports

-   **Shebang**: `#!/usr/bin/env node` makes the script executable.
-   **Argument Parsing**:
    -   Parses `process.argv` to identify commands and options.
    -   Supports `--help` (or `-h`) to display usage instructions.
    -   Supports `--version` (or `-v`) to display the application version from `package.json`.
    -   Supports `--changelog` (with an optional `--verbose` flag) to display the project's `CHANGELOG.md`.
-   **Default Action**: If no specific command flag is provided, it defaults to starting the CodeCompass MCP server.
    -   It accepts an optional `repoPath` argument. If not provided, or if an unrecognized flag is given, it defaults to the current working directory (`.`).
-   **Functions**:
    -   `getPackageVersion()`: Reads and returns the version from `package.json`.
    -   `displayHelp()`: Prints the CLI help message to the console.
    -   `displayChangelog(verbose: boolean)`: Reads and prints `CHANGELOG.md` to the console. Implements in-memory caching for the changelog content to improve performance on repeated calls, with cache invalidation based on file modification time.
-   **Server Initialization**:
    -   Calls `startServer(repoPath)` from `src/lib/server.ts` to initiate the MCP server if no other command is handled.

## Notes

-   This file uses basic `process.argv` parsing and does not rely on external argument parsing libraries to keep dependencies minimal for the CLI entry point.
-   The `changelogCache` uses `node-cache` for efficient caching of the changelog content.
