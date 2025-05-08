#!/usr/bin/env node

import { testDeepSeekConnection, generateWithDeepSeek, generateEmbeddingWithDeepSeek } from '../lib/deepseek';
import { logger } from '../lib/config';

async function main() {
  console.log('🔍 Testing DeepSeek connection...');
  
  try {
    // Test basic connection
    console.log('\n1. Testing API connection:');
    const isConnected = await testDeepSeekConnection();
    console.log(`Connection Test: ${isConnected ? '✅ Successful' : '❌ Failed'}`);
    
    if (isConnected) {
      // Test text generation
      console.log('\n2. Testing text generation:');
      const result = await generateWithDeepSeek('Write a short hello world message');
      console.log(`Generation Test: ${result ? '✅ Successful' : '❌ Failed'}`);
      console.log(`Result: ${result}`);
      
      // Test embedding generation
      console.log('\n3. Testing embedding generation:');
      try {
        const embedding = await generateEmbeddingWithDeepSeek('Hello world');
        console.log(`Embedding Test: ✅ Successful`);
        console.log(`Embedding length: ${embedding.length}`);
        console.log(`First 5 values: [${embedding.slice(0, 5).join(', ')}]`);
      } catch (embeddingError: any) {
        console.log(`Embedding Test: ❌ Failed`);
        console.log(`Error: ${embeddingError.message}`);
      }
    }
    
    console.log('\n🔍 DeepSeek test complete');
  } catch (error: any) {
    console.error('\n❌ Test failed with error:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
