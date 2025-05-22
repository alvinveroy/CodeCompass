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

  const lines = new Set(gitignoreContent.split('\n').map(line => line.trim()));
  let newContent = gitignoreContent;
  let updated = false;

  for (const entry of entriesToEnsure) {
    const trimmedEntry = entry.trim();
    if (!lines.has(trimmedEntry)) {
      newContent += `\n${trimmedEntry}`;
      updated = true;
      lines.add(trimmedEntry);
    }
  }

  if (updated || !fs.existsSync(gitignorePath)) {
    newContent = newContent.trimEnd() + '\n';
    fs.writeFileSync(gitignorePath, newContent, 'utf8');
    process.stdout.write('.gitignore has been updated.\n');
  } else {
    process.stdout.write('.gitignore is already up-to-date.\n');
  }
}

if (require.main === module) {
  updateGitignore();
}
