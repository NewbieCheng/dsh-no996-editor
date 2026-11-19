import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafePublicUrl, fetchWebImageBytes, inspectWebImages, isBlockedIp } from '../src/host/url-assets.mjs';
import { createAssetsTool } from '../src/tools/assets-tool.mjs';

test('isBlockedIp blocks loopback, private, link-local and IPv6 ULA addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.2', '169.254.169.254', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isBlockedIp(ip), true, `expected ${ip} to be blocked`);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isBlockedIp(ip), false, `expected ${ip} to be public`);
  }
});

test('assertSafePublicUrl blocks private DNS targets and non-http schemes', async () => {
  await assert.rejects(() => assertSafePublicUrl('file:///C:/Windows/win.ini'), /仅支持 http/);
  await assert.rejects(() => assertSafePublicUrl('http://127.0.0.1:8080/a.png'), /禁止访问内网/);
  await assert.rejects(
    () => assertSafePublicUrl('https://internal.example', { lookup: async () => [{ address: '10.1.2.3', family: 4 }] }),
    /受限内网地址/,
  );
  const safe = await assertSafePublicUrl('https://example.com/game', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(safe.hostname, 'example.com');
});

test('inspectWebImages and fetchWebImageBytes extract candidate images and enforce magic headers', async () => {
  const pubLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const pngHeader = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

  const fakeFetch = async (url) => {
    if (url === 'https://example.com/product') {
      return new Response(
        `<html><head><title>Awesome Game</title><meta property="og:image" content="/hero.png"></head>
        <body><img src="/pixel.gif" width="1" height="1"><img data-src="https://cdn.example.com/shot.jpg" alt="Gameplay"></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    if (url === 'https://example.com/hero.png') {
      return new Response(pngHeader, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('not-an-image', { status: 200, headers: { 'content-type': 'text/plain' } });
  };

  const info = await inspectWebImages('https://example.com/product', { fetchImpl: fakeFetch, lookup: pubLookup });
  assert.equal(info.title, 'Awesome Game');
  assert.equal(info.images.length, 2);
  assert.equal(info.images[0].url, 'https://example.com/hero.png');
  assert.equal(info.images[1].url, 'https://cdn.example.com/shot.jpg');

  const img = await fetchWebImageBytes('https://example.com/hero.png', { fetchImpl: fakeFetch, lookup: pubLookup });
  assert.equal(img.mediaType, 'image/png');
  assert.equal(img.suggestedName, 'hero.png');

  await assert.rejects(
    () => fetchWebImageBytes('https://example.com/bad', { fetchImpl: fakeFetch, lookup: pubLookup }),
    /不是受支持的 PNG\/JPG\/WebP\/GIF/,
  );

  const uploads = [];
  const tool = createAssetsTool({
    isProjectAgent: () => true,
    projectOf: () => ({ projectId: 'proj1' }),
    http: () => ({
      async put(_url, opts) { uploads.push(opts); return { path: opts.query.path }; },
    }),
    inspectUrl: async () => info,
    fetchUrlImage: async () => img,
  });

  const inspected = await tool.execute({ inspectUrl: 'https://example.com/product' }, { agent: {} });
  assert.match(inspected.text, /Awesome Game/);
  assert.match(inspected.text, /hero\.png/);

  const saved = await tool.execute({ fromUrl: 'https://example.com/hero.png' }, { agent: {} });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].query.path, 'assets/web/hero.png');
  assert.match(saved.text, /assets\/web\/hero\.png/);
});
