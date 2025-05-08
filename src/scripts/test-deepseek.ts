#!/usr/bin/env node

import { testDeepSeekConnection, generateWithDeepSeek } from '../lib/deepseek';

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
      
      // Note: We don't test DeepSeek embeddings anymore as we use Ollama for all embeddings
      console.log('\n3. Note: DeepSeek is no longer used for embeddings');
      console.log('   All embeddings now use Ollama with nomic-embed-text:v1.5 model');
    }
    
    console.log('\n🔍 DeepSeek test complete');
  } catch (error: unknown) {
    const err = error as Error & { 
      response?: { 
        data: unknown; 
        status: number; 
      } 
    };
    console.error('\n❌ Test failed with error:', err.message);
    if (err.response) {
      console.error('Response data:', err.response.data);
      console.error('Response status:', err.response.status);
    }
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
