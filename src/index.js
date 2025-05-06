const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const path = require('path');
const axios = require('axios');
const git = require('isomorphic-git');
const fs = require('fs');
const { QdrantClient } = require('@qdrant/js-client-rest');
const z = require('zod');

// Configuration
const repoPath = process.argv[2];
if (!repoPath) {
  console.error('Please provide a git repository path as an argument.');
  process.exit(1);
}

const ollamaUrl = 'http://localhost:11434';
const qdrantUrl = 'http://localhost:6333';
const collectionName = 'code_chunks';
const chunkSize = 10;
const buildTime = new Date().toISOString(); // Record build time for diff tracking

// Check Ollama availability
async function checkOllama() {
  try {
    await axios.get(ollamaUrl);
    return true;
  } catch (err) {
    console.error('Ollama is not running. Please start it with: ollama serve');
    process.exit(1);
  }
}

// Generate embeddings using Ollama
async function generateEmbeddings(chunks) {
  const embeddings = [];
  for (const chunk of chunks) {
    try {
      const response = await axios.post(`${ollamaUrl}/api/embeddings`, {
        model: 'nomic-embed-text:v1.5',
        prompt: chunk
      });
      embeddings.push(response.data.embedding);
    } catch (err) {
      console.error('Error generating embedding:', err.message);
      throw err;
    }
  }
  return embeddings;
}

// Generate with LLM
async function generateWithLLM(prompt) {
  try {
    const response = await axios.post(`${ollamaUrl}/api/generate`, {
      model: 'llama3.1:8b',
      prompt: prompt,
      stream: false
    });
    return response.data.response;
  } catch (err) {
    console.error('Error generating with LLM:', err.message);
    throw err;
  }
}

// Generate file structure
async function generateFileStructure(dir) {
  const files = await git.listFiles({ fs, dir, ref: 'HEAD' });
  const tree = {};
  for (const file of files) {
    const parts = file.split('/');
    let current = tree;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        current[part] = null;
      } else {
        current[part] = current[part] || {};
        current = current[part];
      }
    }
  }
  function formatTree(obj, indent = '') {
    return Object.keys(obj).map(key => {
      const value = obj[key];
      if (value === null) return `${indent}${key}`;
      return `${indent}${key}/\n${formatTree(value, indent + '  ')}`;
    }).join('\n');
  }
  return formatTree(tree);
}

// Determine if a file is documentation
function isDocumentationFile(file) {
  const docPatterns = ['README.md', 'docs/'];
  return docPatterns.some(pattern => file.startsWith(pattern) || file.toLowerCase() === pattern.toLowerCase());
}

// Build vector database
async function buildVectorDatabase() {
  const client = new QdrantClient({ url: qdrantUrl });
  try {
    await client.getCollections();
  } catch (err) {
    console.error('Qdrant is not running. Please start it with: docker run -p 6333:6333 qdrant/qdrant');
    process.exit(1);
  }
  await client.deleteCollection(collectionName);
  await client.createCollection(collectionName, { vectors: { size: 768, distance: 'Cosine' } });

  const files = await git.listFiles({ fs, dir: repoPath, ref: 'HEAD' });
  const points = [];
  for (const file of files) {
    const { blob } = await git.readBlob({ fs, dir: repoPath, oid: 'HEAD', filepath: file });
    const content = Buffer.from(blob).toString('utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += chunkSize) {
      const chunkLines = lines.slice(i, i + chunkSize);
      const chunk = chunkLines.join('\n');
      if (chunk.trim()) {
        const type = isDocumentationFile(file) ? 'doc' : 'code';
        points.push({ file, start_line: i + 1, end_line: i + chunkLines.length, content: chunk, type });
      }
    }
  }

  const batchSize = 50;
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    const embeddings = await generateEmbeddings(batch.map(p => p.content));
    const qdrantPoints = batch.map((point, idx) => ({
      id: `${point.file}:${point.start_line}-${point.end_line}`,
      vector: embeddings[idx],
      payload: { file: point.file, start_line: point.start_line, end_line: point.end_line, type: point.type }
    }));
    await client.upsert(collectionName, { points: qdrantPoints });
  }
}

// Read chunk from file
async function readChunk(file, startLine, endLine) {
  const { blob } = await git.readBlob({ fs, dir: repoPath, oid: 'HEAD', filepath: file });
  const content = Buffer.from(blob).toString('utf8');
  const lines = content.split('\n');
  return lines.slice(startLine - 1, endLine).join('\n');
}

// Search code function
async function searchCode(query) {
  const queryEmbedding = await generateEmbeddings([query]);
  const client = new QdrantClient({ url: qdrantUrl });
  const results = await client.search(collectionName, { vector: queryEmbedding[0], limit: 5 });
  return results;
}

// Main function
async function main() {
  console.log('Checking Ollama availability...');
  await checkOllama();
  console.log('Building vector database...');
  await buildVectorDatabase();
  console.log('Setting up MCP server...');

  const server = new McpServer({ name: 'git-repo-analyzer', version: '1.0.0' });

  // Resource: repo://structure
  server.resource('repo://structure', async () => ({
    content: [{ type: 'text', text: await generateFileStructure(repoPath) }]
  }));

  // Resource: repo://files/*
  server.resource(
    uri => uri.startsWith('repo://files/'),
    async (request) => {
      const filePath = request.uri.replace('repo://files/', '');
      const { blob } = await git.readBlob({ fs, dir: repoPath, oid: 'HEAD', filepath: filePath });
      return { content: [{ type: 'text', text: Buffer.from(blob).toString('utf8') }] };
    }
  );

  // Tool: search_code
  server.tool('search_code', { query: z.string() }, async ({ query }) => {
    const results = await searchCode(query);
    const formatted = await Promise.all(results.map(async result => {
      const { file, start_line, end_line } = result.payload;
      const code = await readChunk(file, start_line, end_line);
      return `File: ${file}\nLines: ${start_line}-${end_line}\nCode:\n${code}`;
    }));
    return { content: [{ type: 'text', text: formatted.join('\n\n') || 'No results found.' }] };
  });

  // Tool: generate_suggestion
  server.tool('generate_suggestion', { query: z.string() }, async ({ query }) => {
    const results = await searchCode(query);
    const snippets = await Promise.all(results.map(async result => {
      const { file, start_line, end_line } = result.payload;
      return await readChunk(file, start_line, end_line);
    }));
    const prompt = `Based on the following code snippets from the repository, provide a suggestion or completion for the query: "${query}"\n\nCode Snippets:\n${snippets.join('\n\n')}\n\nSuggestion:`;
    const suggestion = await generateWithLLM(prompt);
    return { content: [{ type: 'text', text: suggestion }] };
  });

  // Tool: get_repository_context
  server.tool('get_repository_context', { query: z.string() }, async ({ query }) => {
    const results = await searchCode(query);
    const docSnippets = [];
    const codeSnippets = [];
    for (const result of results) {
      const { file, start_line, end_line, type } = result.payload;
      const content = await readChunk(file, start_line, end_line);
      if (type === 'doc') {
        docSnippets.push({ file, content });
      } else {
        codeSnippets.push({ file, start_line, end_line, content });
      }
    }

    // Summarize code snippets
    const codeSummaries = await Promise.all(codeSnippets.map(async snippet => {
      const summaryPrompt = `Summarize the following code snippet in one or two sentences, focusing on its main functionality or purpose.\n\nCode:\n${snippet.content}\n\nSummary:`;
      const summary = await generateWithLLM(summaryPrompt).catch(() => 'Unable to summarize this snippet.');
      return `File: ${snippet.file}, Lines: ${snippet.start_line}-${snippet.end_line}\nSummary: ${summary}`;
    }));

    // Format documentation snippets
    const docFormatted = docSnippets.map(snippet => `File: ${snippet.file}\nContent:\n${snippet.content}`).join('\n\n');

    // Construct the prompt
    let prompt;
    if (docSnippets.length === 0 && codeSnippets.length === 0) {
      prompt = `You are assisting with a coding task in a repository. The user has asked: "${query}"

Unfortunately, no relevant documentation or code snippets were found in the repository for this query. Please try to answer based on general knowledge or ask for more information.`;
    } else {
      const docSection = docSnippets.length > 0 ? `Documentation:\n${docFormatted}\n\n` : '';
      const codeSection = codeSummaries.length > 0 ? `Code Summaries:\n${codeSummaries.join('\n\n')}\n\n` : '';
      prompt = `You are assisting with a coding task in a repository. The user has asked: "${query}"

The repository context was last updated on ${buildTime}.

Here is some relevant context from the repository:

${docSection}${codeSection}Based on this context, please provide guidance or code suggestions.`;
    }
    return { content: [{ type: 'text', text: prompt }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('MCP server running. Connect via stdio.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});