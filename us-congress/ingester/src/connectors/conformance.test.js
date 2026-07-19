/**
 * Contract conformance: every load-stage node in pipeline.manifest.js must
 * name its connector module, and that module must export the documented
 * contract shape (CONNECTORS.md): SOURCE_NAME, a pure transform, and a load
 * orchestrator. Drift between the manifest and the modules fails the suite,
 * matching the repo's manifest-as-source-of-truth idiom.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nodes } from '../../pipeline.manifest.js';

const loadNodes = nodes.filter((n) => n.stage === 'load');

test('every load-stage manifest node names its connector module', () => {
  assert.equal(loadNodes.length > 0, true, 'expected load-stage nodes in the manifest');
  for (const node of loadNodes) {
    assert.equal(
      typeof node.module,
      'string',
      `load-stage node '${node.id}' has no module field naming its connector`,
    );
    assert.match(node.module, /^src\/connectors\//, `node '${node.id}' module should live under src/connectors/`);
  }
});

for (const node of loadNodes) {
  test(`connector module for '${node.id}' exports the contract shape`, async () => {
    const mod = await import(new URL(`../../${node.module}`, import.meta.url));

    assert.equal(typeof mod.SOURCE_NAME, 'string', `${node.module} must export SOURCE_NAME`);
    assert.equal(typeof mod.transform, 'function', `${node.module} must export a transform function`);
    assert.equal(typeof mod.load, 'function', `${node.module} must export a load orchestrator`);

    // The module's source key must be the one the manifest's watermark row
    // tracks — the handshake and the module can never drift apart silently.
    assert.match(
      node.watermark.key,
      new RegExp(`source_name='${mod.SOURCE_NAME}'`),
      `${node.module} SOURCE_NAME '${mod.SOURCE_NAME}' does not match node '${node.id}' watermark key`,
    );
  });
}
