#!/usr/bin/env node

import { switchLLMProvider, getLLMProvider } from './llm-provider';
import { logger, LLM_PROVIDER } from './config';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
CodeCompass LLM Provider CLI

Usage:
  provider-cli [command]

Commands:
  status              Show current LLM provider
  switch <provider>   Switch to a different LLM provider (ollama or deepseek)
  test                Test the current LLM provider connection

Examples:
  provider-cli status
  provider-cli switch ollama
  provider-cli switch deepseek
  provider-cli test
    `);
    return;
  }

  const command = args[0];

  switch (command) {
    case 'status':
      console.log(`Current LLM provider: ${LLM_PROVIDER}`);
      break;
    
    case 'switch': {
      if (args.length < 2) {
        console.error('Error: Missing provider argument. Use "ollama" or "deepseek"');
        process.exit(1);
      }
      
      const provider = args[1].toLowerCase();
      if (provider !== 'ollama' && provider !== 'deepseek') {
        console.error('Error: Invalid provider. Use "ollama" or "deepseek"');
        process.exit(1);
      }
      
      console.log(`Switching to ${provider} provider...`);
      const success = await switchLLMProvider(provider);
      
      if (success) {
        console.log(`Successfully switched to ${provider} provider.`);
        console.log(`To make this change permanent, set the LLM_PROVIDER environment variable to '${provider}'`);
      } else {
        console.error(`Failed to switch to ${provider} provider. Check the logs for details.`);
        process.exit(1);
      }
      break;
    
    case 'test': {
      console.log(`Testing ${LLM_PROVIDER} provider connection...`);
      const llmProvider = await getLLMProvider();
      const available = await llmProvider.checkConnection();
      
      if (available) {
        console.log(`${LLM_PROVIDER} provider is available and working correctly.`);
      } else {
        console.error(`${LLM_PROVIDER} provider is not available. Check your configuration.`);
        process.exit(1);
      }
      break;
    
    default:
      console.error(`Unknown command: ${command}`);
      console.log('Use --help to see available commands');
      process.exit(1);
  }
}

main().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
