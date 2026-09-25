// Deterministic protocol peer: never invokes Codex, Docker, GitHub, or a model.
// IPC is a test-control/inspection channel; all app-server traffic uses stdio.
import { createInterface } from 'node:readline';

const [role, mode = 'normal', workerId = 'fixture'] = process.argv.slice(2);
const effort = role === 'reviewer' ? 'high' : 'medium';
const threadId = `thread-${workerId}`;
let turnNumber = 0;
let turnId;
let questionId;
let answered = false;
const log = [];
function wire(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function notify(method, params) { wire({ method, params }); }
function response(id, result) { wire({ id, result }); }
function finish(status = 'completed') {
  if (status === 'completed' && turnNumber === 1 && !answered) throw new Error('Cannot finish before the exact answer');
  if (status === 'completed') notify('item/completed', {
    threadId, turnId, completedAtMs: 1,
    item: { type: 'agentMessage', id: `result-${turnId}`, text: `${role}:result:${turnNumber}`, phase: 'final_answer' },
  });
  notify('turn/completed', { threadId, turn: { id: turnId, status, items: [], error: null } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  log.push(message);
  process.send?.({ event: 'wire', message });
  const { id, method, params } = message;
  if (!method) {
    if (id !== questionId || message.result?.answers?.q?.answers?.[0] !== `answer-${role}`) {
      process.send?.({ event: 'wrong-answer', message });
      return;
    }
    answered = true;
    process.send?.({ event: 'answered', workerId });
    notify('item/completed', {
      threadId, turnId, completedAtMs: 1,
      item: { type: 'agentMessage', id: `ack-${turnId}`, text: `${role}:answer-acknowledged`, phase: 'commentary' },
    });
    return;
  }
  if (method === 'initialize') return response(id, { userAgent: 'fixture/0.155.1', platformFamily: 'windows', platformOs: 'windows' });
  if (method === 'initialized') return;
  if (method === 'thread/read') return response(id, { thread: {
    id: threadId, model: mode === 'changed-model' ? 'other-model' : 'gpt-6-astra',
    reasoningEffort: mode === 'lost-effort' ? null : effort,
  } });
  if (method === 'thread/start') {
    const result = {
      model: mode === 'wrong-model' ? 'other-model' : 'gpt-6-astra',
      reasoningEffort: mode === 'wrong-effort' ? 'low' : effort,
      modelProvider: 'openai', cwd: '/workspace', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: ['/workspace'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      thread: { id: threadId, cliVersion: '0.155.1', createdAt: 1, updatedAt: 1, cwd: '/workspace', ephemeral: false, modelProvider: 'openai', preview: '', projectId: null, sessionId: `session-${workerId}`, source: 'appServer', status: { type: 'idle' }, turns: [] },
    };
    if (mode === 'missing-effort') delete result.reasoningEffort;
    if (mode === 'missing-model') delete result.model;
    return response(id, result);
  }
  if (method === 'turn/start') {
    turnId = `turn-${workerId}-${++turnNumber}`;
    if (mode === 'timeout-turn') return;
    response(id, { turn: { id: turnId, status: 'inProgress', items: [], error: null } });
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } });
    if (turnNumber === 1) {
      questionId = `question-${workerId}`;
      wire({ id: questionId, method: 'item/tool/requestUserInput', params: { threadId, turnId, itemId: `ask-${workerId}`, isBlocking: true, questions: [{ id: 'q', header: 'Choice', question: `Choose for ${role}`, options: null }] } });
    }
    return;
  }
  if (method === 'turn/steer') return response(id, { turnId });
  if (method === 'turn/interrupt') return response(id, {}); // Termination requires a separate control signal.
  wire({ id, error: { code: -32601, message: 'Fixture rejects unknown method' } });
});
process.on('message', ({ command, token }) => {
  if (command === 'snapshot') process.send({ token, log, answered, threadId, turnId });
  else if (command === 'complete') { finish(); process.send({ token }); }
  else if (command === 'terminate') { finish('interrupted'); process.send({ token }); }
  else if (command === 'exit') process.exit(0);
});
