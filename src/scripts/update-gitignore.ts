import fs from 'fs';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../../');
const gitignorePath = path.join(projectRoot, '.gitignore');

const entriesToEnsure = [
  '',
  '# CodeCompass specific ignores',
  '/logs/',
  '*.log',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
  '.DS_Store',
  'CHANGELOG.md',
  'RETROSPECTION.md',

  '# Local Cache Files',

  '# IDE specific',
  '.vscode/',
  '.idea/',

  '# Build output',
  '/dist/',

  '# Dependencies',
  '/node_modules/',

  '# Environment variables',
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.test',

  '# Test Output',
  '/coverage/',
  '.vitest-pool',
  '.nyc_output/',
];

function updateGitignore(): void {
  let gitignoreContent = '';
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  }

  const linesInFile = new Set(gitignoreContent.split('\n').map(line => line.trim()));
  let contentToAppend = '';
  let newEntriesAdded = false;

  for (const entry of entriesToEnsure) {
    const trimmedEntry = entry.trim();
    if (!linesInFile.has(trimmedEntry)) {
      // If contentToAppend is empty, this is the first new entry.
      // If gitignoreContent is empty or doesn't end with a newline,
      // the first new entry should ensure a preceding newline if gitignoreContent is not empty.
      if (contentToAppend === '') { // First new entry to append
        if (gitignoreContent.length > 0 && !gitignoreContent.endsWith('\n')) {
          contentToAppend += '\n';
        }
      }
      contentToAppend += trimmedEntry + '\n';
      linesInFile.add(trimmedEntry); // Add to set to avoid duplicate appends if entry appears multiple times in entriesToEnsure
      newEntriesAdded = true;
    }
  }

  if (newEntriesAdded || !fs.existsSync(gitignorePath)) {
    let finalContent = gitignoreContent;
    if (newEntriesAdded) {
      // Ensure existing content ends with a newline before appending, if it's not empty
      if (finalContent.length > 0 && !finalContent.endsWith('\n')) {
        finalContent += '\n';
      }
      finalContent += contentToAppend;
    }
    
    // Ensure the final content (even if it was just initial content that didn't exist) ends with a newline,
    // unless it's completely empty.
    if (finalContent.length > 0 && !finalContent.endsWith('\n')) {
      finalContent += '\n';
    }
    // If the file was initially empty and we only added entries that resulted in just a newline (e.g. only '' was missing and added)
    // or if entriesToEnsure was empty and file didn't exist, finalContent could be empty.
    // If entriesToEnsure guarantees non-empty content (like comments), this is less of a concern.
    // The current entriesToEnsure will always add content if the .gitignore is empty.

    fs.writeFileSync(gitignorePath, finalContent, 'utf8');
    process.stdout.write('.gitignore has been updated.\n');
  } else {
    process.stdout.write('.gitignore is already up-to-date.\n');
  }
}

if (require.main === module) {
  updateGitignore();
}
