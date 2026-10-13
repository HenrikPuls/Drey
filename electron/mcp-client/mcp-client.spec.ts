import { DEFAULT_APP_CONFIG, AppConfig, McpClientServer } from '../../shared/app-config';
import { AssistantToolbox } from './assistant-toolbox';
import {
  McpClientLike,
  McpClientManager,
  TOOL_RESULT_MAX_CHARS,
  exposedToolName,
  flattenToolResult,
  serverIdOfTool,
} from './mcp-client-manager';
import {
  capText,
  htmlToMarkdown,
  parseFetchUrl,
  renderFetched,
  runWebFetch,
} from './web-fetch';

/**
 * The assistant's external tools (milestone 63, ADR-0063): the MCP client
 * manager over a faked SDK client, the toolbox's approval rule, and the
 * pure parts of web_fetch. Main-process code, tested here like the other
 * cross-layer modules.
 */

function server(id: string, patch: Partial<McpClientServer> = {}): McpClientServer {
  return {
    id,
    name: `Server ${id}`,
    enabled: true,
    approval: 'ask',
    transport: { kind: 'http', url: `https://${id}.example/mcp`, headers: {} },
    ...patch,
  };
}

interface FakeClient extends McpClientLike {
  calls: Array<{ name: string; arguments: unknown }>;
  closed: boolean;
}

function fakeClient(
  tools: string[],
  behaviour: { connectError?: string; result?: unknown; callError?: string } = {},
): FakeClient {
  const client = {
    calls: [] as FakeClient['calls'],
    closed: false,
    connect: async () => {
      if (behaviour.connectError !== undefined) {
        throw new Error(behaviour.connectError);
      }
    },
    listTools: async () => ({
      tools: tools.map((name) => ({
        name,
        description: `does ${name}`,
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      })),
    }),
    callTool: async (params: { name: string; arguments?: unknown }) => {
      client.calls.push({ name: params.name, arguments: params.arguments });
      if (behaviour.callError !== undefined) {
        throw new Error(behaviour.callError);
      }
      return behaviour.result ?? { content: [{ type: 'text', text: `ran ${params.name}` }] };
    },
    close: async () => {
      client.closed = true;
    },
  };
  return client as unknown as FakeClient;
}

function managerWith(clients: FakeClient[]): { manager: McpClientManager; created: () => number } {
  let next = 0;
  const manager = new McpClientManager({
    createClient: () => clients[Math.min(next++, clients.length - 1)],
    createTransport: () => ({}) as never,
    log: () => undefined,
  });
  return { manager, created: () => next };
}

/** Lets the fire-and-forget connects settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('MCP tool names', () => {
  it('namespaces, sanitises and caps a tool name; reads the server id back', () => {
    expect(exposedToolName('brave', 'web_search')).toBe('mcp__brave__web_search');
    expect(exposedToolName('s', 'a.b/c')).toBe('mcp__s__a_b_c');
    expect(exposedToolName('s', 'x'.repeat(100))).toHaveLength(64);
    expect(serverIdOfTool('mcp__brave-search__web_search')).toBe('brave-search');
    expect(serverIdOfTool('vault_read')).toBeNull();
  });

  it('flattens a result to text: blocks joined, non-text named, errors marked, long text capped', () => {
    expect(
      flattenToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }),
    ).toBe('a\n[image omitted]\nb');
    expect(flattenToolResult({ content: [{ type: 'text', text: 'nope' }], isError: true })).toBe('Error: nope');
    expect(flattenToolResult({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
    expect(flattenToolResult({ content: [] })).toBe('(empty result)');
    const long = flattenToolResult({ content: [{ type: 'text', text: 'x'.repeat(TOOL_RESULT_MAX_CHARS + 50) }] });
    expect(long).toContain('[truncated, 50 more characters]');
  });
});

describe('McpClientManager', () => {
  it('connects enabled servers and exposes their tools under the server prefix', async () => {
    const client = fakeClient(['web_search']);
    const { manager } = managerWith([client]);
    manager.sync([server('brave'), server('off', { enabled: false })]);
    expect(manager.status()).toEqual([{ id: 'brave', state: 'connecting', error: null, tools: [] }]);
    await settle();

    expect(manager.status()).toEqual([{ id: 'brave', state: 'ready', error: null, tools: ['web_search'] }]);
    const [spec] = manager.toolSpecs();
    expect(spec.name).toBe('mcp__brave__web_search');
    expect(spec.description).toBe('[Server brave] does web_search');
    expect(spec.parameters.required).toEqual(['q']);

    expect(await manager.call('mcp__brave__web_search', { q: 'x' })).toBe('ran web_search');
    expect(client.calls).toEqual([{ name: 'web_search', arguments: { q: 'x' } }]);
  });

  it('keeps a failing server in the list with its error and offers none of its tools', async () => {
    const { manager } = managerWith([fakeClient([], { connectError: 'ECONNREFUSED' })]);
    manager.sync([server('down')]);
    await settle();
    expect(manager.status()).toEqual([{ id: 'down', state: 'error', error: 'ECONNREFUSED', tools: [] }]);
    expect(manager.toolSpecs()).toEqual([]);
  });

  it('a call to a failed server retries the connection once', async () => {
    const good = fakeClient(['t']);
    const { manager, created } = managerWith([fakeClient([], { connectError: 'boom' }), good]);
    manager.sync([server('s')]);
    await settle();
    expect(await manager.call('mcp__s__t', {})).toBe('ran t');
    expect(created()).toBe(2);
  });

  it('a tool failure comes back as text', async () => {
    const { manager } = managerWith([fakeClient(['t'], { callError: 'timed out' })]);
    manager.sync([server('s')]);
    await settle();
    expect(await manager.call('mcp__s__t', {})).toBe('Error: timed out');
    expect(await manager.call('mcp__s__other', {})).toMatch(/unknown tool/);
    expect(await manager.call('mcp__gone__t', {})).toMatch(/unknown tool/);
  });

  it('sync drops removed servers, reconnects a changed transport and keeps an unchanged one', async () => {
    const first = fakeClient(['t']);
    const second = fakeClient(['t2']);
    const { manager, created } = managerWith([first, second]);
    manager.sync([server('s')]);
    await settle();

    manager.sync([server('s', { approval: 'allow' })]);
    await settle();
    expect(created()).toBe(1);
    expect(manager.server('s')?.approval).toBe('allow');

    manager.sync([server('s', { transport: { kind: 'http', url: 'https://other/mcp', headers: {} } })]);
    await settle();
    expect(first.closed).toBe(true);
    expect(manager.status()[0].tools).toEqual(['t2']);

    manager.sync([]);
    await settle();
    expect(second.closed).toBe(true);
    expect(manager.status()).toEqual([]);
  });
});

describe('AssistantToolbox', () => {
  function toolbox(
    patch: (tools: AppConfig['tools']) => void,
    answer: boolean,
  ): {
    box: AssistantToolbox;
    asked: Array<{ source: string; tool: string }>;
    fetched: unknown[];
    client: FakeClient;
    ready: () => Promise<void>;
  } {
    const config = structuredClone(DEFAULT_APP_CONFIG);
    patch(config.tools);
    const client = fakeClient(['web_search']);
    const { manager } = managerWith([client]);
    manager.sync(config.tools.servers);
    const asked: Array<{ source: string; tool: string }> = [];
    const fetched: unknown[] = [];
    const box = new AssistantToolbox(
      () => config,
      manager,
      async (request) => {
        asked.push({ source: request.source, tool: request.tool });
        return answer;
      },
      async (args) => {
        fetched.push(args);
        return 'page';
      },
    );
    return { box, asked, fetched, client, ready: settle };
  }

  it('offers web_fetch only when on, plus the connected servers', async () => {
    const off = toolbox(() => undefined, true);
    expect(off.box.specs()).toEqual([]);

    const on = toolbox((t) => {
      t.webFetch.enabled = true;
      t.servers = [server('brave')];
    }, true);
    await on.ready();
    expect(on.box.specs().map((s) => s.name)).toEqual(['web_fetch', 'mcp__brave__web_search']);
  });

  it('"ask" asks per call and a denial does not run it', async () => {
    const h = toolbox((t) => {
      t.webFetch.enabled = true;
      t.servers = [server('brave')];
    }, false);
    await h.ready();
    expect(await h.box.run('web_fetch', '{"url":"https://a"}')).toMatch(/declined/);
    expect(await h.box.run('mcp__brave__web_search', '{"q":"x"}')).toMatch(/declined/);
    expect(h.asked).toEqual([
      { source: 'web', tool: 'web_fetch' },
      { source: 'brave', tool: 'web_search' },
    ]);
    expect(h.fetched).toEqual([]);
    expect(h.client.calls).toEqual([]);
  });

  it('"allow" runs without asking; an approval runs after asking', async () => {
    const allowed = toolbox((t) => {
      t.webFetch = { enabled: true, approval: 'allow' };
      t.servers = [server('brave', { approval: 'allow' })];
    }, false);
    await allowed.ready();
    expect(await allowed.box.run('web_fetch', '{"url":"https://a"}')).toBe('page');
    expect(await allowed.box.run('mcp__brave__web_search', '{"q":"x"}')).toBe('ran web_search');
    expect(allowed.asked).toEqual([]);

    const asked = toolbox((t) => void (t.webFetch.enabled = true), true);
    expect(await asked.box.run('web_fetch', '{"url":"https://a"}')).toBe('page');
    expect(asked.asked).toHaveLength(1);
  });

  it('refuses web_fetch while it is off, unknown tools and unparsable arguments', async () => {
    const h = toolbox(() => undefined, true);
    expect(await h.box.run('web_fetch', '{"url":"https://a"}')).toMatch(/turned off/);
    expect(await h.box.run('mcp__nope__t', '{}')).toMatch(/unknown tool/);
    expect(await h.box.run('web_fetch', '{oops')).toMatch(/could not parse/);
    expect(h.asked).toEqual([]);
  });
});

describe('web_fetch', () => {
  it('accepts only http(s) URLs', () => {
    expect(parseFetchUrl('https://example.org/a')).toBeInstanceOf(URL);
    expect(parseFetchUrl('file:///c:/secret.txt')).toEqual({ error: 'only http and https URLs can be fetched' });
    expect(parseFetchUrl('not a url')).toHaveProperty('error');
    expect(parseFetchUrl(undefined)).toEqual({ error: 'url is required' });
  });

  it('turns a page into Markdown without scripts, styles and page chrome', () => {
    const markdown = htmlToMarkdown(
      '<html><head><title>My  page</title><style>p{}</style></head><body>' +
        '<nav><a href="/">Home</a></nav><script>alert(1)</script>' +
        '<h2>Topic</h2><p>Some <strong>text</strong> and a <a href="https://x.org">link</a>.</p>' +
        '<footer>imprint</footer></body></html>',
    );
    expect(markdown).toBe('# My page\n\n## Topic\n\nSome **text** and a [link](https://x.org).');
  });

  it('renders by content type and rejects what is not text', () => {
    expect(renderFetched('text/html; charset=utf-8', '<p>hi</p>')).toBe('hi');
    expect(renderFetched('application/json', ' {"a":1} ')).toBe('{"a":1}');
    expect(renderFetched('text/plain', 'plain')).toBe('plain');
    expect(renderFetched('image/png', 'bytes')).toBeNull();
  });

  it('caps the returned text', () => {
    expect(capText('abcdef', 3)).toBe('abc\n[truncated, 3 more characters]');
    expect(capText('abc', undefined)).toBe('abc');
  });

  it('fetches, converts and reports failures as text', async () => {
    const page = (async () =>
      new Response('<p>Hello</p>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    expect(await runWebFetch({ url: 'https://example.org' }, undefined, page)).toBe('Hello');

    const missing = (async () => new Response('', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;
    expect(await runWebFetch({ url: 'https://example.org/x' }, undefined, missing)).toBe(
      'Error: https://example.org/x answered 404 Not Found',
    );

    const down = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    expect(await runWebFetch({ url: 'https://nowhere.example' }, undefined, down)).toMatch(/could not fetch/);
    expect(await runWebFetch({ url: 'ftp://x' }, undefined, page)).toMatch(/only http and https/);
  });
});
