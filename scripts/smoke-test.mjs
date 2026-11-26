// Imports the built package by its own name under plain Node, the way a consumer
// without a bundler would. Catches output that only resolves through a bundler.
import assert from 'node:assert/strict';

const pkg = await import('@kodehub.id/fetch-streamer');
assert.equal(typeof pkg.FetchStreamer, 'function');
assert.equal(typeof pkg.FetchStreamerHttpError, 'function');
console.log('smoke test: package imports under Node', process.version);
