import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import * as net from 'node:net';
import { TOOLS, callTool } from '../src/mcp/tools.js';
import { withFixture } from './helpers.js';

// The offline guarantee: no tool opens a network connection or resolves a host name. (The only network use is
// the opt-in neural model download, which these tools do not trigger without opting in.)
test('no tool touches the network', async () => {
  const attempts: string[] = [];
  const realConnect = net.Socket.prototype.connect;
  const realLookup = dns.lookup;
  const realFetch = globalThis.fetch;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    attempts.push(`socket ${JSON.stringify(args[0])}`);
    throw new Error('network disabled in this test');
  } as typeof net.Socket.prototype.connect;
  (dns as { lookup: unknown }).lookup = (host: string) => {
    attempts.push(`dns ${host}`);
    throw new Error('network disabled in this test');
  };
  globalThis.fetch = (async (input: unknown) => {
    attempts.push(`fetch ${String(input)}`);
    throw new Error('network disabled in this test');
  }) as typeof fetch;

  try {
    await withFixture({
      'package.json': JSON.stringify({ name: 'offline-app', devDependencies: { vitest: '^2.0.0' } }),
      'app/api/keys/route.ts': "import { db } from '../../../lib/db';\nexport async function DELETE() {\n  await db.apiKey.delete({ where: { id: '1' } });\n  return new Response(null);\n}\n",
      'app/keys/page.tsx': "export default function Keys() {\n  const revoke = () => fetch('/api/keys', { method: 'DELETE' });\n  return <button onClick={revoke}>Revoke</button>;\n}\n",
      'lib/db.ts': "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();\n",
      'prisma/schema.prisma': 'model ApiKey {\n  id String @id\n}\n',
      'tests/keys.test.ts': "import { test } from 'vitest';\nimport { db } from '../lib/db';\ntest('db', () => db);\n"
    }, async root => {
      const args: Record<string, Record<string, unknown>> = {
        search: { query: 'revoke api key' },
        feature_slice: { feature: 'api key revocation' },
        trace_flow: { feature: 'revoke api key' },
        impact: { target: 'lib/db.ts' },
        review_diff: { diff: 'diff --git a/lib/db.ts b/lib/db.ts\n--- a/lib/db.ts\n+++ b/lib/db.ts\n@@ -1,1 +1,2 @@\n import x\n+export const y = 1;\n' },
        api_map: {},
        codebase_overview: {},
        quality_scan: {}
      };
      for (const tool of TOOLS) {
        const result = await callTool(root, tool.name, args[tool.name]);
        assert.ok(!result.isError, `${tool.name}: ${result.content[0].text.slice(0, 200)}`);
      }
    });
  } finally {
    net.Socket.prototype.connect = realConnect;
    (dns as { lookup: unknown }).lookup = realLookup;
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(attempts, []);
});
