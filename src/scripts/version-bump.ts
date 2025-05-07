#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Define version bump types
type BumpType = 'major' | 'minor' | 'patch';

// Parse command line arguments
const args = process.argv.slice(2);
const bumpType: BumpType = (args[0] as BumpType) || 'patch';

// Validate bump type
if (!['major', 'minor', 'patch'].includes(bumpType)) {
  console.error('Invalid bump type. Use "major", "minor", or "patch"');
  process.exit(1);
}

// Get the project root directory
const projectRoot = path.resolve(__dirname, '..', '..');

// Read package.json
const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Parse current version
const currentVersion = packageJson.version;
const [major, minor, patch] = currentVersion.split('.').map(Number);

// Calculate new version based on bump type
let newVersion: string;
switch (bumpType) {
  case 'major':
    newVersion = `${major + 1}.0.0`;
    break;
  case 'minor':
    newVersion = `${major}.${minor + 1}.0`;
    break;
  case 'patch':
  default:
    newVersion = `${major}.${minor}.${patch + 1}`;
    break;
}

// Update package.json
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

// Update version.ts
const versionTsPath = path.join(projectRoot, 'src', 'lib', 'version.ts');
const versionTsContent = `// Version information
export const VERSION = '${newVersion}';
`;
fs.writeFileSync(versionTsPath, versionTsContent);

// Log the version change
console.log(`Version bumped from ${currentVersion} to ${newVersion}`);

// Optionally commit the changes
if (args.includes('--commit')) {
  try {
    execSync('git add package.json src/lib/version.ts', { cwd: projectRoot });
    execSync(`git commit -m "chore: bump version to ${newVersion}"`, { cwd: projectRoot });
    console.log('Changes committed to git');
  } catch (error) {
    console.error('Failed to commit changes:', error);
  }
}
