import * as fs from 'fs';
// path is available from configService if needed for local operations
import { configService, logger } from './config-service';

// CONFIG_DIR and MODEL_CONFIG_FILE are now sourced from configService
export const CONFIG_DIR = configService.CONFIG_DIR;
export const MODEL_CONFIG_FILE = configService.MODEL_CONFIG_FILE;

// The functions saveModelConfig, loadModelConfig, and forceUpdateModelConfig
// have been removed. Their functionality is now directly handled by,
// or superseded by, methods within the ConfigService (e.g.,
// configService.persistModelConfiguration(), configService.reloadConfigsFromFile(),
// and the setters like configService.setSuggestionModel()).
// Code that previously called these functions should be updated to use
// ConfigService methods directly.
