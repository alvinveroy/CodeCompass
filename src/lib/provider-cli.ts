#!/usr/bin/env node

import { switchSuggestionModel, getLLMProvider } from './llm-provider';
import { configService } from './config-service';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
CodeCompass LLM Provider CLI

Usage:
  provider-cli [command]

Commands:
  status              Show current suggestion model and provider
  switch <model_name> Switch to a different suggestion model (e.g., "llama3.1:8b", "deepseek-coder")
  test                Test the current LLM provider connection

Examples:
  provider-cli status
  provider-cli switch llama3.1:8b
  provider-cli switch deepseek-coder
  provider-cli test
    `);
    return;
  }

  const command = args[0];

  switch (command) {
    case 'status':
      console.log(`Current Suggestion Model: ${configService.SUGGESTION_MODEL}`);
      console.log(`Current Suggestion Provider: ${configService.SUGGESTION_PROVIDER}`);
      console.log(`Current Embedding Provider: ${configService.EMBEDDING_PROVIDER}`);
      break;
    
    case 'switch': {
      if (args.length < 2) {
        console.error('Error: Missing model name argument. E.g., "llama3.1:8b" or "deepseek-coder"');
        process.exit(1);
      }
      
      const modelName = args[1]; // Keep original casing, switchSuggestionModel will normalize
      
      console.log(`Switching to suggestion model: ${modelName}...`);
      const success = await switchSuggestionModel(modelName);
      
      if (success) {
        console.log(`Successfully switched to suggestion model: ${configService.SUGGESTION_MODEL} (Provider: ${configService.SUGGESTION_PROVIDER}).`);
        console.log(`To make this change permanent, set the SUGGESTION_MODEL environment variable to '${configService.SUGGESTION_MODEL}' or update ~/.codecompass/model-config.json.`);
      } else {
        console.error(`Failed to switch to ${provider} provider. Check the logs for details.`);
        process.exit(1);
      }
      break;
    }
    
    case 'test': {
      console.log(`Testing ${configService.LLM_PROVIDER} provider connection...`);
      const llmProvider = await getLLMProvider();
      const available = await llmProvider.checkConnection();
      
      if (available) {
        console.log(`${configService.LLM_PROVIDER} provider is available and working correctly.`);
      } else {
        console.error(`${configService.LLM_PROVIDER} provider is not available. Check your configuration.`);
        process.exit(1);
      }
      break;
    }
    
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
