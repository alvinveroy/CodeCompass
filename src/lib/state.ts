import * as path from 'path';
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
  repoPath?: string; // Ensure this is present
  // Add/Ensure these debug properties are present and optional
  _debug_retrievalCount?: number;
  _debug_lastRetrievedAt?: number;
}

// In-memory state storage
const sessions: Map<string, SessionState> = new Map();
// Use globalThis to ensure SESSIONS_MAP_INSTANCE_ID is set once per process,
// preventing redeclaration errors if the module is somehow evaluated multiple times.
if (!(globalThis as any).SESSIONS_MAP_INSTANCE_ID_CODECOMPASS) {
  (globalThis as any).SESSIONS_MAP_INSTANCE_ID_CODECOMPASS = `sessions-map-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  logger.info(`[STATE_INIT_DEBUG] Sessions Map initialized (via globalThis). Instance ID: ${(globalThis as any).SESSIONS_MAP_INSTANCE_ID_CODECOMPASS}`);
}
const SESSIONS_MAP_INSTANCE_ID = (globalThis as any).SESSIONS_MAP_INSTANCE_ID_CODECOMPASS;

// Create a new session
export function createSession(repoPath: string, sessionIdToUse?: string): SessionState {
  const sessionId = sessionIdToUse || generateSessionId();
  // Change logger.info to include new debug fields, ensure it's logger.info
  logger.info(`[STATE_DEBUG] createSession (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): Creating new session. ID: '${sessionId}', repoPath: '${repoPath}'. Provided sessionId was: '${sessionIdToUse}'. Initial retrieval count: 0.`);
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
    repoPath, // Ensure repoPath is assigned here
    _debug_retrievalCount: 0, // Initialize
    _debug_lastRetrievedAt: Date.now(), // Initialize
  };
      
  sessions.set(sessionId, session);
  logger.info(`Created new session: ${sessionId}`);
  logger.info(`[STATE_DEBUG] createSession: Session '${sessionId}' created and stored. Retrieval count: ${session._debug_retrievalCount}, Last retrieved at: ${new Date(session._debug_lastRetrievedAt!).toISOString()}`);
  return session;
}

// Get or create a session
export function getOrCreateSession(sessionId?: string, repoPath?: string): SessionState {
  const callStack = new Error().stack?.split('\n').slice(2, 4).map(s => s.trim()).join(' <- ') || 'unknown stack';
  // Change logger.debug to logger.info for the main entry log
  logger.info(`[STATE_DEBUG] getOrCreateSession (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): sid='${sessionId}', repo='${repoPath}'. Caller: ${callStack}. Current session keys: [${Array.from(sessions.keys()).join(', ')}]`);
  logger.info(`[STATE_DEBUG] getOrCreateSession accessing SESSIONS_MAP_INSTANCE_ID: ${SESSIONS_MAP_INSTANCE_ID}`); // This line remains, but the one above is modified
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastUpdated = Date.now();
    session._debug_retrievalCount = (session._debug_retrievalCount || 0) + 1; // Increment
    session._debug_lastRetrievedAt = Date.now(); // Timestamp
    // Log queries immediately after retrieval for existing session
    console.log(`[STATE_CONSOLE_DEBUG] getOrCreateSession (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): EXISTING session '${sessionId}' queries BEFORE return (deep copy): ${JSON.stringify(session.queries, null, 2)}`);
    // Change logger.info to include new debug fields and ensure it's logger.info, and use session.repoPath
    logger.info(`[STATE_DEBUG] getOrCreateSession (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): Returning EXISTING session '${sessionId}'. Queries: ${session.queries.length}. Retrieval count: ${session._debug_retrievalCount}, Last retrieved at: ${new Date(session._debug_lastRetrievedAt).toISOString()}. RepoPath: ${session.repoPath}`);
    return session;
  }
  
  if (!repoPath) { // If no repoPath to create a new one (sessionId might be new or undefined)
     logger.error(`[STATE_DEBUG] getOrCreateSession (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): repoPath is required to create a new session if sessionId is not found or provided.`);
     throw new Error("repoPath is required to create a new session.");
  }

  logger.info(`[STATE_DEBUG] getOrCreateSession (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): SessionId '${sessionId}' not found or not provided. Creating new session with repoPath: '${repoPath}'.`);
  const newSession = createSession(repoPath!, sessionId); 
  // createSession now initializes _debug_retrievalCount and logs it.
  console.log(`[STATE_CONSOLE_DEBUG] getOrCreateSession (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): CREATED NEW session '${newSession.id}' queries (deep copy): ${JSON.stringify(newSession.queries, null, 2)}`);
  return newSession;
}

// Add a query to session
export function addQuery(
  sessionId: string, 
  query: string, 
  results: unknown[] = [], 
  relevanceScore = 0,
  repoPath?: string 
): SessionState {
  logger.info(`[STATE_DEBUG] addQuery accessing SESSIONS_MAP_INSTANCE_ID: ${SESSIONS_MAP_INSTANCE_ID}`); // This line remains
  const session = getOrCreateSession(sessionId, repoPath); // This will log SESSIONS_MAP_INSTANCE_ID
  const newQueryEntry = { timestamp: Date.now(), query, results, relevanceScore };
  console.log(`[STATE_CONSOLE_DEBUG] addQuery (Map ID: ${SESSIONS_MAP_INSTANCE_ID}) for session '${session.id}': BEFORE immutable update. Current queries (deep copy): ${JSON.stringify(session.queries, null, 2)}`);
  logger.info(`[STATE_DEBUG] addQuery (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): BEFORE adding to session '${session.id}'. Session ID: ${session.id}, Repo: ${session.repoPath}, Queries count: ${session.queries.length}, Retrieval count: ${session._debug_retrievalCount}, Last retrieved: ${session._debug_lastRetrievedAt ? new Date(session._debug_lastRetrievedAt).toISOString() : 'N/A'}`);
  // Immutable update:
  session.queries = [...session.queries, newQueryEntry];
  console.log(`[STATE_CONSOLE_DEBUG] addQuery (Map ID: ${SESSIONS_MAP_INSTANCE_ID}) for session '${session.id}': AFTER immutable update. New queries (deep copy): ${JSON.stringify(session.queries, null, 2)}`);
  // Log reflects the immutable update
  logger.info(`[STATE_DEBUG] addQuery (Map ID: ${SESSIONS_MAP_INSTANCE_ID}) for ${session.id}: REPLACED (immutable) queries array. New length: ${session.queries.length}, content: ${JSON.stringify(session.queries.map(q => q.query))}`);
  session.lastUpdated = Date.now();
  // Add a log after pushing the query
  logger.info(`[STATE_DEBUG] addQuery (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): AFTER adding to session '${session.id}'. Session ID: ${session.id}, Repo: ${session.repoPath}, Total queries: ${session.queries.length}. Retrieval count: ${session._debug_retrievalCount}, Last retrieved: ${session._debug_lastRetrievedAt ? new Date(session._debug_lastRetrievedAt).toISOString() : 'N/A'}`);
  return session;
}

// Add this new export if sessions map is not directly exportable/accessible
export function getRawSessionForDebug(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

// Add this new export
export function getInMemorySessionKeys(): string[] {
  return Array.from(sessions.keys());
}

// Add a suggestion to session
export function addSuggestion(
  sessionId: string,
  prompt: string,
  suggestion: string,
  repoPath?: string // Allow repoPath for session creation
): SessionState {
  const session = getOrCreateSession(sessionId, repoPath); // Use getOrCreateSession
  
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
  comments: string,
  repoPath?: string // Allow repoPath for session creation
): SessionState {
  const session = getOrCreateSession(sessionId, repoPath); // Use getOrCreateSession
  
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
  repoPathValue?: string, // Renamed to avoid conflict with SessionState.repoPath
  lastFiles?: string[],
  lastDiff?: string
): SessionState {
  const session = getOrCreateSession(sessionId, repoPathValue); // Use getOrCreateSession, pass repoPathValue for creation
  
  if (repoPathValue) { // Use repoPathValue for updating context
    session.context.repoPath = repoPathValue; 
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
  const callStack = new Error().stack?.split('\n').slice(2, 4).map(s => s.trim()).join(' <- ') || 'unknown stack';
  logger.info(`[STATE_DEBUG] getSessionHistory accessing SESSIONS_MAP_INSTANCE_ID: ${SESSIONS_MAP_INSTANCE_ID}`); // This line remains
  logger.info(`[STATE_DEBUG] getSessionHistory (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): Requested for sid='${sessionId}'. Found: ${sessions.has(sessionId)}. Caller: ${callStack}. Current session keys: [${Array.from(sessions.keys()).join(', ')}]`);
  if (!sessions.has(sessionId)) {
    // Log existing sessions for easier debugging if a specific one is not found
    console.log(`[STATE_CONSOLE_DEBUG] getSessionHistory (Map ID: ${SESSIONS_MAP_INSTANCE_ID}) for ${sessionId}: Session not found. Queries (deep copy): N/A`); // Log before throw
    const existingSessionIds = Array.from(sessions.keys());
    logger.warn(`[STATE_DEBUG] getSessionHistory (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): Session not found: '${sessionId}'. Existing session IDs: [${existingSessionIds.join(', ')}]. Caller: ${callStack}`); // Keep as warn
    throw new Error(`Session not found: ${sessionId}`);
  }
  const session = sessions.get(sessionId)!;
  // Log queries immediately after retrieval
  if (session) { // Add a check for session existence
      console.log(`[STATE_CONSOLE_DEBUG] getSessionHistory (Map ID: ${SESSIONS_MAP_INSTANCE_ID}) for ${sessionId}: Immediately after map get - queries (deep copy): ${JSON.stringify(session.queries, null, 2)}`);
  } else {
      logger.warn(`[STATE_DEBUG] getSessionHistory (Map ID: ${SESSIONS_MAP_INSTANCE_ID}) for ${sessionId}: Session NOT FOUND in map immediately at get.`);
  }
  logger.info(`[STATE_DEBUG] getSessionHistory (Map ID: ${SESSIONS_MAP_INSTANCE_ID}) for ${sessionId}: ENTRY - queries (deep copy): ${JSON.stringify(session.queries, null, 2)}`);
  session._debug_retrievalCount = (session._debug_retrievalCount || 0) + 1; // Increment
  session._debug_lastRetrievedAt = Date.now(); // Timestamp
  const queryLog = session.queries.slice(-3).map(q => ({ q: q.query, ts: q.timestamp, score: q.relevanceScore })); // Match user's requested queryLog
  // Change logger.info to include new debug fields and ensure it's logger.info
  logger.info(`[STATE_DEBUG] getSessionHistory (Map ID: ${SESSIONS_MAP_INSTANCE_ID}): Returning for session '${sessionId}'. Queries: ${session.queries.length}. Recent: ${JSON.stringify(queryLog)}. Retrieval count: ${session._debug_retrievalCount}, Last retrieved at: ${new Date(session._debug_lastRetrievedAt).toISOString()}. RepoPath: ${session.repoPath}`);
  return session;
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
  finalResponse: string,
  repoPath?: string // Allow repoPath for session creation
): SessionState {
  const session = getOrCreateSession(sessionId, repoPath); // Use getOrCreateSession
  
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
