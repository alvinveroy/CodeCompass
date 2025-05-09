import { logger } from "./config-service";

// Session state interface
export interface SessionState {
  id: string;
  queries: {
    timestamp: number;
    query: string;
    results: unknown[];
    relevanceScore: number;
  }[];
  suggestions: {
    timestamp: number;
    prompt: string;
    suggestion: string;
    feedback?: {
      score: number;
      comments: string;
    };
  }[];
  context: {
    repoPath: string;
    lastFiles: string[];
    lastDiff: string;
  };
  agentSteps?: {
    timestamp: number;
    query: string;
    steps: {
      tool: string;
      input: unknown;
      output: unknown;
      reasoning: string;
    }[];
    finalResponse: string;
  }[];
  createdAt: number;
  lastUpdated: number;
}

// In-memory state storage
const sessions: Map<string, SessionState> = new Map();

// Create a new session
export function createSession(repoPath: string): SessionState {
  const sessionId = generateSessionId();
  const session: SessionState = {
    id: sessionId,
    queries: [],
    suggestions: [],
    context: {
      repoPath,
      lastFiles: [],
      lastDiff: "",
    },
    agentSteps: [],
    createdAt: Date.now(),
    lastUpdated: Date.now(),
  };
  
  sessions.set(sessionId, session);
  logger.info(`Created new session: ${sessionId}`);
  return session;
}

// Get or create a session
export function getOrCreateSession(sessionId?: string, repoPath?: string): SessionState {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastUpdated = Date.now();
    return session;
  }
  
  if (!repoPath) {
    throw new Error("Repository path is required to create a new session");
  }
  
  return createSession(repoPath);
}

// Add a query to session
export function addQuery(
  sessionId: string, 
  query: string, 
  results: unknown[] = [], 
  relevanceScore = 0
): SessionState {
  const session = getOrCreateSession(sessionId);
  
  session.queries.push({
    timestamp: Date.now(),
    query,
    results,
    relevanceScore,
  });
  
  session.lastUpdated = Date.now();
  return session;
}

// Add a suggestion to session
export function addSuggestion(
  sessionId: string,
  prompt: string,
  suggestion: string
): SessionState {
  const session = getOrCreateSession(sessionId);
  
  session.suggestions.push({
    timestamp: Date.now(),
    prompt,
    suggestion,
  });
  
  session.lastUpdated = Date.now();
  return session;
}

// Add feedback to the latest suggestion
export function addFeedback(
  sessionId: string,
  score: number,
  comments: string
): SessionState {
  const session = getOrCreateSession(sessionId);
  
  if (session.suggestions.length === 0) {
    throw new Error("No suggestions found to add feedback to");
  }
  
  const latestSuggestion = session.suggestions[session.suggestions.length - 1];
  latestSuggestion.feedback = {
    score,
    comments,
  };
  
  session.lastUpdated = Date.now();
  return session;
}

// Update context in session
export function updateContext(
  sessionId: string,
  repoPath?: string,
  lastFiles?: string[],
  lastDiff?: string
): SessionState {
  const session = getOrCreateSession(sessionId);
  
  if (repoPath) {
    session.context.repoPath = repoPath;
  }
  
  if (lastFiles) {
    session.context.lastFiles = lastFiles;
  }
  
  if (lastDiff) {
    session.context.lastDiff = lastDiff;
  }
  
  session.lastUpdated = Date.now();
  return session;
}

// Get session history
export function getSessionHistory(sessionId: string): SessionState {
  if (!sessions.has(sessionId)) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  
  return sessions.get(sessionId)!;
}

// Clear session
export function clearSession(sessionId: string): void {
  if (sessions.has(sessionId)) {
    sessions.delete(sessionId);
    logger.info(`Cleared session: ${sessionId}`);
  }
}

// Generate a unique session ID
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Get the most recent queries
export function getRecentQueries(sessionId: string, limit = 5): string[] {
  const session = getOrCreateSession(sessionId);
  return session.queries
    .slice(-limit)
    .map(q => q.query);
}

// Get the most relevant results from previous queries
export function getRelevantResults(sessionId: string, limit = 3): unknown[] {
  const session = getOrCreateSession(sessionId);
  return session.queries
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit)
    .flatMap(q => q.results);
}

// Calculate average relevance score for a session
export function getAverageRelevanceScore(sessionId: string): number {
  const session = getOrCreateSession(sessionId);
  if (session.queries.length === 0) return 0;
  
  const sum = session.queries.reduce((acc, q) => acc + q.relevanceScore, 0);
  return sum / session.queries.length;
}

// Add agent steps to session
export function addAgentSteps(
  sessionId: string,
  query: string,
  steps: {
    tool: string;
    input: unknown;
    output: unknown;
    reasoning: string;
  }[],
  finalResponse: string
): SessionState {
  const session = getOrCreateSession(sessionId);
  
  if (!session.agentSteps) {
    session.agentSteps = [];
  }
  
  session.agentSteps.push({
    timestamp: Date.now(),
    query,
    steps,
    finalResponse
  });
  
  session.lastUpdated = Date.now();
  return session;
}

// Get the most recent agent steps
export function getRecentAgentSteps(sessionId: string, limit = 3): unknown[] {
  const session = getOrCreateSession(sessionId);
  
  if (!session.agentSteps) {
    return [];
  }
  
  return session.agentSteps
    .slice(-limit)
    .map(step => ({
      query: step.query,
      tools: step.steps.map(s => s.tool),
      timestamp: step.timestamp
    }));
}
