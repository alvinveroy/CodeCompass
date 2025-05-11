# Documentation for `src/scripts/version-bump.ts`

This document provides an overview and explanation of the `src/scripts/version-bump.ts` file.

## Purpose

The `version-bump.ts` script is a command-line utility for automating the project's versioning process. It handles incrementing the version number in `package.json` and `src/lib/version.ts` according to semantic versioning rules (major, minor, patch). Additionally, it offers options to update the `CHANGELOG.md` file, commit the changes to Git, push the commit to a remote repository, and publish the package to npm.

## Key Features and Logic

1.  **Argument Parsing**:
    *   Parses command-line arguments (`process.argv.slice(2)`).
    *   Determines the `bumpType` (`major`, `minor`, `patch`) from the first argument, defaulting to `patch`.
    *   Checks for boolean flags: `--commit`, `--push`, `--changelog`, `--publish`.
    *   Validates `bumpType`; exits if invalid.

2.  **Version Calculation**:
    *   Resolves the project root directory.
    *   Reads `package.json`, parses its content, and extracts the current `version`.
    *   Splits the version into major, minor, and patch components.
    *   Calculates the `newVersion` string based on the `bumpType`.

3.  **File Updates**:
    *   **`package.json`**: Reads the entire file content, then uses string replacement (`replace(/"version": "[^"]+"/, ...`) to update only the version field, preserving other formatting. Writes the modified content back.
    *   **`src/lib/version.ts`**: Overwrites the file with the content: `// Version information\nexport const VERSION = '${newVersion}';\n`.

4.  **Changelog Update (`--changelog`)**:
    *   Reads `CHANGELOG.md`.
    *   Gets the current date in `YYYY-MM-DD` format.
    *   If `## [Unreleased]` section exists, it replaces this line with `## [Unreleased]\n\n## [${newVersion}] - ${date}`, effectively "releasing" the unreleased changes under the new version and adding a new `## [Unreleased]` section above it.
    *   If `## [Unreleased]` does not exist, it attempts to find the main `# Changelog` header (using a regex `^# Changelog.*?(\r?\n){2}/s`) and inserts a new version section (with `### Added`, `### Changed`, `### Fixed` placeholders) after it.
    *   If no proper header is found, it prepends the new version section to the changelog.
    *   Logs success or failure of the changelog update.

5.  **Git Integration (`--commit`, `--push`)**:
    *   If `--commit` is specified:
        *   Collects files to commit: `package.json`, `src/lib/version.ts`, and `CHANGELOG.md` (if `updateChangelog` was true).
        *   Executes `git add ${filesToCommit.join(' ')}`.
        *   Executes `git commit -m "chore: bump version to ${newVersion}"`.
    *   If `--push` is specified (and `--commit` was successful):
        *   Executes `git push`.
    *   Logs success or failure of git operations.

6.  **NPM Publishing (`--publish`)**:
    *   If `--publish` is specified:
        *   Logs "Building project before publishing...".
        *   Executes `npm run build` (inheriting stdio).
        *   Logs "Publishing version ${newVersion} to npm...".
        *   Executes `npm publish` (inheriting stdio).
        *   Logs success or failure; exits with status 1 on failure.

7.  **Logging**: Provides console output for the version bump, file updates, and outcomes of git/npm operations.

## Type Definition

```typescript
type BumpType = 'major' | 'minor' | 'patch';
```

## Usage

The script is executed using `ts-node` (as indicated by `#!/usr/bin/env node` and its TypeScript nature) and is typically invoked via npm scripts defined in `package.json`:

*   `npm run version:patch`: Bumps patch version.
*   `npm run version:minor`: Bumps minor version.
*   `npm run version:major`: Bumps major version.
*   `npm run version:commit`: Bumps patch version and commits changes.
*   `npm run version:release`: Bumps patch, updates changelog, commits, and pushes.
*   `npm run version:minor-release`: Bumps minor, updates changelog, commits, and pushes.
*   `npm run version:major-release`: Bumps major, updates changelog, commits, and pushes.

The `publish:local` script in `package.json` uses `npm version patch` directly, which is a separate mechanism from this script's `--publish` flag.

This script is a comprehensive tool for managing the release process, ensuring consistency and automation across versioning, changelog updates, and optional Git/NPM operations.
