import fs from 'fs';
import path from 'path';

// Read version from package.json
function getPackageVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8');
    const packageJson: { version?: string } = JSON.parse(packageJsonContent);
    return packageJson.version || '1.1.3'; // Fallback to previous hardcoded version
  } catch (error) {
    console.error('Error reading package.json version:', error);
    return '1.1.3'; // Fallback to previous hardcoded version
  }
}

// Version information
export const VERSION = getPackageVersion();
