#!/usr/bin/env node

import { startServer } from './lib/server';

// Get repository path from command line arguments or use current directory
const repoPath = process.argv[2] || ".";

// Start the server
startServer(repoPath);
