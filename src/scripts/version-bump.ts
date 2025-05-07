#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// Define version bump types
type BumpType = 'major' | 'minor' | 'patch';

// Parse command line arguments
const args = process.argv.slice(2);
const bumpType: BumpType = (args[0] as BumpType) || 'patch';
const shouldCommit = args.includes('--commit');
const shouldPush = args.includes('--push');
const updateChangelog = args.includes('--changelog');

// Validate bump type
if (!['major', 'minor', 'patch'].includes(bumpType)) {
  console.error('Invalid bump type. Use "major", "minor", or "patch"');
  process.exit(1);
}

// Get the project root directory
const projectRoot = path.resolve(__dirname, '..', '..');

// Read package.json
const packageJsonPath = path.join(projectRoot, 'package.json');
const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
const packageJson = JSON.parse(packageJsonContent);

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

// Update package.json while preserving formatting
const updatedPackageJsonContent = packageJsonContent.replace(
  /"version": "[^"]+"/,
  `"version": "${newVersion}"`
);
fs.writeFileSync(packageJsonPath, updatedPackageJsonContent);

// Update version.ts
const versionTsPath = path.join(projectRoot, 'src', 'lib', 'version.ts');
const versionTsContent = `// Version information
export const VERSION = '${newVersion}';
`;
fs.writeFileSync(versionTsPath, versionTsContent);

// Update CHANGELOG.md if requested
if (updateChangelog) {
  try {
    const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
    const changelogContent = fs.readFileSync(changelogPath, 'utf8');
    
    const date = new Date().toISOString().split('T')[0];
    
    // Check if there's an [Unreleased] section
    if (changelogContent.includes('## [Unreleased]')) {
      // Replace [Unreleased] with the new version and date
      const updatedChangelog = changelogContent.replace(
        '## [Unreleased]',
        `## [Unreleased]\n\n## [${newVersion}] - ${date}`
      );
      fs.writeFileSync(changelogPath, updatedChangelog);
    } else {
      // If no [Unreleased] section, add new version after the header
      const headerMatch = changelogContent.match(/^# Changelog.*?(\r?\n){2}/s);
      if (headerMatch) {
        const header = headerMatch[0];
        const rest = changelogContent.substring(header.length);
        const newEntry = `## [${newVersion}] - ${date}\n\n### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n\n`;
        fs.writeFileSync(changelogPath, header + newEntry + rest);
      } else {
        // If no proper header, just prepend the new version
        const newEntry = `## [${newVersion}] - ${date}\n\n### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n\n`;
        fs.writeFileSync(changelogPath, newEntry + changelogContent);
      }
    }
    console.log(`Updated CHANGELOG.md with new version ${newVersion}`);
  } catch (error) {
    console.error('Failed to update CHANGELOG.md:', error);
  }
}

// Log the version change
console.log(`Version bumped from ${currentVersion} to ${newVersion}`);

// Optionally commit the changes
if (shouldCommit) {
  try {
    const filesToCommit = ['package.json', 'src/lib/version.ts'];
    if (updateChangelog) {
      filesToCommit.push('CHANGELOG.md');
    }
    
    execSync(`git add ${filesToCommit.join(' ')}`, { cwd: projectRoot });
    execSync(`git commit -m "chore: bump version to ${newVersion}"`, { cwd: projectRoot });
    console.log('Changes committed to git');
    
    // Optionally push the changes
    if (shouldPush) {
      execSync('git push', { cwd: projectRoot });
      console.log('Changes pushed to remote repository');
    }
  } catch (error) {
    console.error('Failed to commit/push changes:', error);
  }
}
