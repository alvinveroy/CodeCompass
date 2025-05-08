import fs from 'fs';
import path from 'path';

// Read version from package.json
function getPackageVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version;
  } catch (error) {
    console.error('Error reading package.json version:', error);
    return '1.1.3'; // Fallback to previous hardcoded version
  }
}

// Version information
export const VERSION = getPackageVersion();
