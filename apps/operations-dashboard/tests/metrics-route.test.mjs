import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual route module offline, substituting only auth and transport.
const dataSource = readFileSync(
  new URL('../lib/dashboard-data.ts', import.meta.url),
  'utf8',
);
const routeSource = readFileSync(
  new URL('../app/api/metrics/route.ts', import.meta.url),
  'utf8',
);
const appRegistry = JSON.parse(
  readFileSync(
    new URL('../../../cloudbase/apps.json', import.meta.url),
    'utf8',
  ),
);
function compile(source, context = {}) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        resolveJsonModule: true,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports,
      URL,
      Response,
      AbortSignal,
      setTimeout: (callback) => callback(),
      ...context,
    },
  );
  return exports;
}
const data = compile(dataSource);
function route({
  user = { userId: 'test-owner' },
  token = 'offline-test-token',
  transport = async () => {
    throw new Error('offline');
  },
} = {}) {
  return compile(routeSource, {
    process: {
      env: { NODE_ENV: 'production', CLOUDBASE_METRICS_TOKEN: token },
    },
    fetch: transport,
    require: (name) =>
      name.includes('chatgpt-auth')
        ? { getChatGPTUser: async () => user }
        : name.endsWith('cloudbase/apps.json')
          ? appRegistry
          : data,
  }).GET;
}
const request = (query = 'app=all&days=7') =>
  new Request(`https://dashboard.test/api/metrics?${query}`);
const registeredReleaseStreams = appRegistry.apps.flatMap((app) =>
  app.release_streams.map((stream) => ({ appId: app.app_id, ...stream })),
);
function releaseSummary(stream) {
  const populated = stream.code !== 'bifang-screen-recorder-macos-arm64';
  return {
    appId: stream.appId,
    code: stream.code,
    platform: stream.platform,
    architecture: stream.architecture,
    channel: stream.channel,
    highestVersion: populated
      ? stream.appId === 'bifang-mouse-clicker'
        ? '0.2.4'
        : '1.10'
      : null,
    status: populated
      ? stream.appId === 'bifang-mouse-clicker'
        ? 'normal'
        : 'prompt'
      : 'empty',
    updatedAt: populated ? '2026-09-07T03:00:00.000Z' : null,
  };
}
function fixture(selectedAppId = 'all') {
  return {
    schemaVersion: 2,
    mode: 'live',
    connection: 'connected',
    connectionNote: '生产集合',
    environmentId: 'bifang-telemetry-prod-d8efa6a8d3',
    timezone: 'Asia/Shanghai',
    generatedAt: '2026-09-07T05:00:00Z',
    rangeDays: 7,
    selectedAppId,
    totals: {
      todayActive: 0,
      yesterdayActive: 0,
      periodActive: 0,
      returningToday: 0,
      returningRate: 0,
      lastReceivedAt: null,
    },
    trend: Array.from({ length: 7 }, (_, i) => ({
      date: `2026-09-0${i + 1}`,
      total: 0,
      byApp: { 'bifang-screen-recorder': 0, 'bifang-mouse-clicker': 0 },
    })),
    versions: [],
    platforms: [],
    architectures: [],
    releaseStreams: registeredReleaseStreams
      .filter(
        (stream) => selectedAppId === 'all' || stream.appId === selectedAppId,
      )
      .map(releaseSummary),
    alerts: [],
  };
}
test('unauthenticated production requests are rejected before data access', async () => {
  const result = await route({ user: null })(request());
  assert.equal(result.status, 401);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('missing configuration and failed upstream never return demo or zero data', async () => {
  for (const options of [
    { token: '' },
    {},
    { transport: async () => new Response('error', { status: 500 }) },
  ]) {
    const result = await route(options)(request());
    assert.equal(result.status, 503);
    assert.deepEqual(Object.keys(await result.json()), ['error']);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
});
test('invalid, duplicate and unexpected filters fail before fetching', async () => {
  for (const query of [
    'app=other',
    'days=8',
    'days=07',
    'days=7&days=14',
    'app=all&app=all',
    'admin=true',
  ]) {
    let fetched = false;
    const result = await route({
      transport: async () => {
        fetched = true;
        throw new Error();
      },
    })(request(query));
    assert.equal(result.status, 400, query);
    assert.equal(fetched, false);
  }
});
test('live response is explicitly rebuilt and credentials stay server-side', async () => {
  const payload = fixture();
  payload.install_id = 'must-not-leave-proxy';
  payload.totals.source_ip = 'must-not-leave-proxy';
  payload.trend[0].event_id = 'must-not-leave-proxy';
  payload.releaseStreams[0].downloadUrl = 'must-not-leave-proxy';
  payload.releaseStreams[0].appSecret = 'must-not-leave-proxy';
  const result = await route({
    transport: async (url, options) => {
      assert.equal(
        url.origin,
        'https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com',
      );
      assert.equal(url.search, '?days=7');
      assert.equal(options.headers.Authorization, 'Bearer offline-test-token');
      return Response.json(payload);
    },
  })(request());
  assert.equal(result.status, 200);
  const text = await result.text();
  assert.equal(
    /install_id|source_ip|event_id|downloadUrl|appSecret|offline-test-token/.test(
      text,
    ),
    false,
  );
  assert.equal(JSON.parse(text).totals.todayActive, 0);
});
test('all and selected-app responses require the exact registered stream set', async () => {
  for (const selectedAppId of [
    'all',
    'bifang-screen-recorder',
    'bifang-mouse-clicker',
  ]) {
    const payload = fixture(selectedAppId);
    payload.releaseStreams.reverse();
    const result = await route({
      transport: async (url) => {
        assert.equal(url.searchParams.get('days'), '7');
        assert.equal(
          url.searchParams.get('app_id'),
          selectedAppId === 'all' ? null : selectedAppId,
        );
        return Response.json(payload);
      },
    })(request(`app=${selectedAppId}&days=7`));
    assert.equal(result.status, 200, selectedAppId);
    assert.deepEqual(
      (await result.json()).releaseStreams.map((stream) => stream.code).sort(),
      registeredReleaseStreams
        .filter(
          (stream) => selectedAppId === 'all' || stream.appId === selectedAppId,
        )
        .map((stream) => stream.code)
        .sort(),
      selectedAppId,
    );
  }
});
test('wrong environment, query, schema and demo responses fail closed', async () => {
  for (const change of [
    { environmentId: 'staging' },
    { rangeDays: 14 },
    { selectedAppId: 'bifang-mouse-clicker' },
    { mode: 'demo' },
    { schemaVersion: 1 },
    { totals: null },
  ]) {
    const result = await route({
      transport: async () => Response.json({ ...fixture(), ...change }),
    })(request());
    assert.equal(result.status, 503);
  }
});

test('invalid release codes, cross-app rows and contradictory empty states fail closed', async () => {
  const invalidPayloads = [
    (() => {
      const value = fixture();
      value.releaseStreams[0].code = 'Unknown-Code';
      return value;
    })(),
    (() => {
      const value = fixture();
      value.releaseStreams[0].appId = 'bifang-mouse-clicker';
      value.selectedAppId = 'bifang-screen-recorder';
      return value;
    })(),
    (() => {
      const value = fixture();
      value.releaseStreams[1].highestVersion = '1.0';
      return value;
    })(),
  ];
  for (const payload of invalidPayloads) {
    const query =
      payload.selectedAppId === 'bifang-screen-recorder'
        ? 'app=bifang-screen-recorder&days=7'
        : undefined;
    const result = await route({
      transport: async () => Response.json(payload),
    })(request(query));
    assert.equal(result.status, 503);
  }
});

test('missing, extra, duplicate and oversized release stream sets fail closed', async () => {
  const invalidSets = [
    [],
    fixture().releaseStreams.slice(1),
    [
      ...fixture().releaseStreams,
      {
        ...fixture().releaseStreams[0],
        code: 'extra-release-stream',
      },
    ],
    [
      fixture().releaseStreams[0],
      fixture().releaseStreams[0],
      fixture().releaseStreams[2],
    ],
    Array.from({ length: 13 }, (_, index) => ({
      ...fixture().releaseStreams[0],
      code: `oversized-release-stream-${index}`,
    })),
  ];
  for (const releaseStreams of invalidSets) {
    const result = await route({
      transport: async () => Response.json({ ...fixture(), releaseStreams }),
    })(request());
    assert.equal(result.status, 503);
  }
});

test('every registered release identity field is bound exactly', async () => {
  for (const change of [
    { appId: 'bifang-mouse-clicker' },
    { code: 'unregistered-release-stream' },
    { platform: 'linux' },
    { architecture: 'ia32' },
    { channel: 'preview' },
  ]) {
    const payload = fixture();
    payload.releaseStreams[0] = { ...payload.releaseStreams[0], ...change };
    const result = await route({
      transport: async () => Response.json(payload),
    })(request());
    assert.equal(result.status, 503, JSON.stringify(change));
  }
});

test('rate limits get bounded backoff, never an unbounded retry or fake result', async () => {
  let calls = 0;
  const recovered = await route({
    transport: async () =>
      ++calls === 1
        ? new Response('limited', { status: 429 })
        : Response.json(fixture()),
  })(request());
  assert.equal(recovered.status, 200);
  assert.equal(calls, 2);
  calls = 0;
  const exhausted = await route({
    transport: async () => {
      calls += 1;
      return new Response('limited', { status: 429 });
    },
  })(request());
  assert.equal(exhausted.status, 503);
  assert.equal(calls, 3);
});
