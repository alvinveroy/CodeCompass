import fs from 'fs-extra';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../../');
const hooksSourceDir = path.join(projectRoot, 'src', 'templates', 'hooks');
const gitHooksDir = path.join(projectRoot, '.git', 'hooks');

const availableHooks = ['post-commit'];

async function installHooks(): Promise<void> {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    process.stderr.write('This does not appear to be a Git repository. .git directory not found.\n');
    process.exit(1);
  }

  if (!fs.existsSync(gitHooksDir)) {
    process.stdout.write(`.git/hooks directory not found. Creating it at ${gitHooksDir}\n`);
    try {
      await fs.ensureDir(gitHooksDir);
    } catch (dirError: unknown) {
      const error = dirError instanceof Error ? dirError : new Error(String(dirError));
      process.stderr.write(`Failed to create .git/hooks directory: ${error.message}\n`);
      process.exit(1);
    }
  }

  for (const hookName of availableHooks) {
    const sourceHookPath = path.join(hooksSourceDir, hookName);
    const destHookPath = path.join(gitHooksDir, hookName);

    if (!fs.existsSync(sourceHookPath)) {
      process.stdout.write(`Hook template ${sourceHookPath} not found. Skipping ${hookName}.\n`);
      continue;
    }

    try {
      await fs.copy(sourceHookPath, destHookPath, { overwrite: true });
      await fs.chmod(destHookPath, '755');
      process.stdout.write(`Installed git hook: ${hookName} to ${destHookPath}\n`);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      process.stderr.write(`Failed to install git hook ${hookName}: ${err.message}\n`);
    }
  }
  process.stdout.write('Git hook installation process finished.\n');
}

if (require.main === module) {
  installHooks().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    process.stderr.write(`Error during hook installation: ${error.message}\n`);
    process.exit(1);
  });
}
