import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Workspace } from '../packages/core/dist/index.js';

/**
 * Exercises a real agent turn end to end without an API key.
 *
 * A local server speaks the OpenAI streaming format and is driven by a script:
 * first round asks for a board_create_artifact tool call, second round returns
 * plain text. That covers the part of the system no other test reaches — the
 * loop from message to model to tool to a node appearing inside the agent's
 * frame — and it does so deterministically, which a live model would not.
 */

const check = (label, condition, extra = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!condition) process.exitCode = 1;
};

// ------------------------------------------------------------- fake provider

const requests = [];
let round = 0;

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }

    requests.push(JSON.parse(body));
    round += 1;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    if (round === 1) {
      const args = JSON.stringify({
        kind: 'status',
        title: 'Сборка',
        headline: 'Готовлю окружение',
        detail: 'Ставлю зависимости и проверяю версии',
        tone: 'running'
      });
      sse(res, {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'board_create_artifact', arguments: '' } }
              ]
            }
          }
        ]
      });
      // Split mid-string so the accumulator's chunk joining is exercised too.
      const half = Math.floor(args.length / 2);
      sse(res, {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }]
      });
      sse(res, {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }]
      });
      sse(res, { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
    } else {
      for (const piece of ['Поставил ', 'зависимости, ', 'статус на доске.']) {
        sse(res, { choices: [{ delta: { content: piece } }] });
      }
      sse(res, { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 } });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });
});

await new Promise((resolve) => server.listen(8799, '127.0.0.1', resolve));

// -------------------------------------------------------------------- set up

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zmtki-agent-'));
const ws = new Workspace(path.join(tmp, 'app'));
await ws.init();

const seen = [];
ws.onEvent.on((event) => seen.push(event));

const board = await ws.submit({
  id: 'a1',
  op: { type: 'workspace.createBoard', path: path.join(tmp, 'board'), name: 'Ход' }
});
const boardId = board.value.boardId;

const provider = await ws.submit({
  id: 'a2',
  op: {
    type: 'provider.upsert',
    endpoint: { label: 'fake', baseUrl: 'http://127.0.0.1:8799/v1', apiKey: 'x', models: ['fake-model'] }
  }
});
check('эндпоинт добавлен', provider.ok, provider.ok ? provider.value[0]?.provider : provider.error);
await ws.submit({ id: 'a3', op: { type: 'settings.set', patch: { defaultModel: 'fake-model' } } });

const agentResult = await ws.submit({
  id: 'a4',
  op: { type: 'agent.create', boardId, name: 'Девопс', persona: 'настраивает окружение' }
});
const agent = agentResult.value.agent;
const roomId = agentResult.value.roomId;

// -------------------------------------------------------------- run the turn

const completed = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('ход не завершился за 30с')), 30_000);
  ws.onEvent.on((event) => {
    if (event.type === 'turn.completed' && event.agentId === agent.id) {
      clearTimeout(timer);
      resolve(event);
    }
    if (event.type === 'turn.failed' && event.agentId === agent.id) {
      clearTimeout(timer);
      reject(new Error(event.error));
    }
  });
});

const sent = await ws.submit({
  id: 'a5',
  op: { type: 'room.send', roomId, body: 'Подготовь окружение и покажи статус', steer: true }
});
check('сообщение отправлено и разбудило агента', sent.ok && sent.value.woke.length === 1);

let turn;
try {
  turn = await completed;
} catch (err) {
  check('ход завершился', false, err.message);
  await ws.shutdown();
  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(1);
}

// ------------------------------------------------------------------- asserts

// turn.completed fires inside runTurn, before the caller posts the reply into
// the room, so give that tail end a tick before asserting on room state.
await new Promise((resolve) => setTimeout(resolve, 250));

check('ход завершился штатно', turn.stopReason === 'done', turn.stopReason);
check('модель вызвана дважды: инструмент, затем ответ', requests.length === 2, `${requests.length}`);

const first = requests[0];
check('в запрос переданы схемы инструментов', Array.isArray(first.tools) && first.tools.length > 10, `${first.tools?.length}`);
check(
  'есть инструмент создания артефакта',
  first.tools.some((t) => t.function?.name === 'board_create_artifact')
);
check('стриминг включён', first.stream === true);

const systemText = first.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
check('в промпте есть протокол артефактов', systemText.includes('Протокол артефактов'));
check('в промпте описан htmlWidget как способ показать что угодно', systemText.includes('htmlWidget'));
check('в промпте есть персона агента', systemText.includes('настраивает окружение'));
check('в промпте есть рамка агента', systemText.includes('Твоя рамка'));

const second = requests[1];
const toolReply = second.messages.find((m) => m.role === 'tool');
check('результат инструмента вернулся модели', Boolean(toolReply), toolReply?.content?.slice(0, 60));

const session = ws.session(boardId);
const artifacts = session.board.nodes.filter((n) => n.type === 'artifact');
check('артефакт появился на доске', artifacts.length === 1, `${artifacts.length}`);
// The fake model sends status fields flat instead of nested under `props`,
// which is the mistake real models make most often here.
check('поля артефакта разобраны, даже присланные плоско', artifacts[0]?.artifact.headline === 'Готовлю окружение');
check('артефакт помечен автором', artifacts[0]?.createdBy === agent.id);

const frame = session.board.nodes.find((n) => n.type === 'frame' && n.agentId === agent.id);
const inside =
  artifacts[0].position.x >= frame.position.x &&
  artifacts[0].position.y >= frame.position.y &&
  artifacts[0].position.x + artifacts[0].size.w <= frame.position.x + frame.size.w;
check('артефакт лежит внутри рамки агента', inside, JSON.stringify(artifacts[0].position));

check('ответ агента ушёл в комнату', ws.session(boardId) && seen.some(
  (e) => e.type === 'room.message' && e.message.author.id === agent.id && e.message.body.includes('зависимости')
));

const deltas = seen.filter((e) => e.type === 'turn.messageDelta');
check('текст стримился по кусочкам', deltas.length >= 3, `${deltas.length} дельт`);

const toolEvents = seen.filter((e) => e.type === 'turn.toolCall');
check('вызов инструмента виден в UI-событиях', toolEvents.length >= 2, `${toolEvents.length}`);
check('вызов завершился успешно', toolEvents.at(-1)?.call.status === 'ok', toolEvents.at(-1)?.call.status);

check('токены посчитаны', turn.usage.totalTokens === 370, `${turn.usage.totalTokens}`);
check('агент вернулся в покой', session.agents.get(agent.id)?.status === 'idle');

const rollout = await fs
  .readFile(path.join(tmp, 'board', '.zmtki', 'rollouts', `${agent.id}.jsonl`), 'utf8')
  .catch(() => '');
check('история хода записана на диск', rollout.includes('board_create_artifact') || rollout.length > 0);

await ws.shutdown();
server.close();
await fs.rm(tmp, { recursive: true, force: true });
console.log(process.exitCode ? '\nЕсть падения.' : '\nПолный цикл хода агента работает.');
