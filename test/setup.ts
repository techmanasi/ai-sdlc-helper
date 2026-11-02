import { beforeEach } from 'vitest';

// Vitest sends each test's result to the main process over IPC and reads the reply from the event loop. A file whose
// tests are all synchronous (spawnSync git, sync fs) never returns to the loop until its last test ends, so the replies
// sit unread; when the file blocks for over 60s (Vitest's RPC timeout) the first call is rejected as soon as the loop
// turns, before the waiting reply is read, and the run ends with an unhandled "Timeout calling onTaskUpdate". One turn
// of the loop before each test lets the replies in. Captured here so a test's fake timers cannot replace it.
const realSetImmediate = setImmediate;
beforeEach(() => new Promise<void>(resolve => realSetImmediate(resolve)));
