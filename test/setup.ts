import { beforeEach } from 'vitest';

// Vitest sends each test's result to the main process over IPC and reads the reply from the event loop. A file whose
// tests are all synchronous (spawnSync git, sync fs) never returns to the loop until its last test ends, so the replies
// sit unread; when the file blocks for over 60s (Vitest's RPC timeout) the first call is rejected as soon as the loop
// turns, before the waiting reply is read, and the run ends with an unhandled "Timeout calling onTaskUpdate". One turn
// of the loop before each test lets the replies in. Captured here so a test's fake timers cannot replace it.
const realSetImmediate = setImmediate;
beforeEach(() => new Promise<void>(resolve => realSetImmediate(resolve)));

// The pipeline runs this suite as its green gate with the run's own settings in the environment (AGENT_<STAGE>,
// MODEL_<STAGE>, EFFORT_<STAGE>, SDLC_AUTO_ACCEPT, SDLC_CREATE_PR, SDLC_SLUG, MAX_*). Tests that start a pipeline or build
// agent commands read those same names, so a run configured with per-stage agents made them fail. Tests set what they need.
for (const name of Object.keys(process.env)) {
  if (/^(AGENT|MODEL|EFFORT)_[A-Z_]+$/.test(name) || ['SDLC_AUTO_ACCEPT', 'SDLC_CREATE_PR', 'SDLC_SLUG', 'SDLC_MODEL', 'SDLC_EFFORT', 'SDLC_AGENT', 'MAX_TURNS', 'MAX_ATTEMPTS', 'MAX_REPAIR_TESTS'].includes(name)) delete process.env[name];
}
