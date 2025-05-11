# Documentation for `src/scripts/set-deepseek-key.ts`

This document provides an overview and explanation of the `src/scripts/set-deepseek-key.ts` file.

## Purpose

The `set-deepseek-key.ts` script is a command-line utility designed to configure the DeepSeek API key for the CodeCompass application. It facilitates setting the API key either through a command-line argument or by reading it from the `DEEPSEEK_API_KEY` environment variable.

The script's primary function is to save the API key and the DeepSeek API URL to a JSON configuration file located at `~/.codecompass/deepseek-config.json`. After saving the configuration, it attempts to test the connection to the DeepSeek API to verify the key.

## Key Logic

1.  **API Key Retrieval**: The script first attempts to get the API key from the first command-line argument (`process.argv[2]`). If not provided, it falls back to the `DEEPSEEK_API_KEY` environment variable.
2.  **Validation**: It checks if an API key was successfully retrieved. If no key is found, it prints usage instructions to `console.error` and exits with a status code of 1.
3.  **Configuration Directory**: It ensures the configuration directory (`~/.codecompass`) exists by creating it if necessary. The home directory is determined using `process.env.HOME` or `process.env.USERPROFILE`.
4.  **Configuration File**: It constructs a configuration object containing:
    *   `DEEPSEEK_API_KEY`: The provided API key.
    *   `DEEPSEEK_API_URL`: The URL for the DeepSeek API, defaulting to `"https://api.deepseek.com/chat/completions"` or using the value from `process.env.DEEPSEEK_API_URL` if set.
    *   `timestamp`: The current date and time in ISO format.
    This object is then written to `deepseek-config.json` within the configuration directory.
5.  **Environment Update**: The script sets `process.env.DEEPSEEK_API_KEY` to the provided key for the current execution context.
6.  **Connection Test**: It dynamically imports the `testDeepSeekConnection` function from `../lib/deepseek.ts` and calls it to verify that the newly configured API key allows for a successful connection to DeepSeek.
7.  **Feedback**: It logs messages to the console indicating where the key was saved and the result (success or failure) of the connection test.
8.  **Error Handling**: The main function is wrapped in a `.catch` block to handle any unhandled promise rejections, logging them and exiting.

## Usage

The script is intended to be run from the command line, typically via an npm script:

```bash
# Provide the API key as a command-line argument
npm run set-deepseek-key YOUR_API_KEY

# Or, set the API key as an environment variable
DEEPSEEK_API_KEY=YOUR_API_KEY npm run set-deepseek-key
```
(Assuming `set-deepseek-key` is an npm script that executes `ts-node src/scripts/set-deepseek-key.ts` or similar, as defined in `package.json`: `"set-deepseek-key": "ts-node src/scripts/set-deepseek-key.ts"`).

This script is crucial for setting up the DeepSeek provider within CodeCompass, ensuring that the application can authenticate with and utilize DeepSeek's services.
