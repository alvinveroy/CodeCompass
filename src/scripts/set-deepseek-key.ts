#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
// Removed unused logger import

/**
 * This script sets the DeepSeek API key in a way that ensures it's available to all parts of the application.
 * It writes the key to a configuration file that's loaded at startup.
 */
async function main() {
  // Get API key from command line argument or environment
  const apiKey = process.argv[2] || process.env.DEEPSEEK_API_KEY;
  
  if (!apiKey) {
    console.error('Error: No API key provided');
    console.error('Usage: npm run set-deepseek-key YOUR_API_KEY');
    console.error('   or: DEEPSEEK_API_KEY=your_key npm run set-deepseek-key');
    process.exit(1);
  }
  
  // Create config directory if it doesn't exist
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.codecompass');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  
  // Write API key to configuration file
  const configFile = path.join(configDir, 'deepseek-config.json');
  const config = {
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_API_URL: process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions",
    timestamp: new Date().toISOString()
  };
  
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  console.log(`DeepSeek API key saved to ${configFile}`);
  
  // Also set it in the current environment
  process.env.DEEPSEEK_API_KEY = apiKey;
  
  // Test the connection
  try {
    import('../lib/deepseek').then(async (deepseek) => {
      console.log('Testing DeepSeek connection...');
      const connected = await deepseek.testDeepSeekConnection();
      if (connected) {
        console.log('✅ Connection successful! The API key is working.');
      } else {
        console.log('❌ Connection failed. The API key may be invalid or there may be network issues.');
      }
    });
  } catch (error: any) {
    console.error('Error testing connection:', error.message);
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
