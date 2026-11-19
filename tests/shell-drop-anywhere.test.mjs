// "素材丢这里" was a promise the page kept nowhere: only the composer card took
// files, so every other pixel showed the system's "no entry" cursor. The patches
// below make the whole chat take a file and give it a real path when the desktop
// window can name one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = path => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const series = JSON.parse(read('patches/series.json'));
const patchBySource = source => {
  const entry = series.patches.find(item => item.source === source);
  assert.ok(entry, `missing patch entry in series.json for ${source}`);
  return read(`patches/${entry.file}`);
};
const app = patchBySource('apps/desktop/chat/src/App.tsx');

test('the chat takes a file anywhere in the page', () => {
  assert.match(app, /\+    const hasFiles = \(data: DataTransfer \| null\) =>/);
  assert.match(app, /\+    document\.addEventListener\('drop', letGo\);/);
  assert.match(app, /\+      attachFiles\(filesFromTransfer\(event\.dataTransfer\), \{ x: event\.clientX, y: event\.clientY \}\);/);
  // the composer's own handler must win: it knows where the caret is
  assert.match(app, /\+      if \(!hasFiles\(event\.dataTransfer\) \|\| event\.defaultPrevented\) return;/);
  // a hover with an empty type list still has to be accepted, or the OS refuses the drop
  assert.match(app, /\+      if \(!event\.dataTransfer\) return;\n\+      event\.preventDefault\(\);/);
  // host-caught drops must clear the stuck "松手即可附上" overlay
  assert.match(app, /\+      setPageDropping\(false\);\n\+      if \(files\?\.length\) attachFiles\(files\);/);
  assert.match(app, /\+    document\.addEventListener\('dragend', end\);/);
});

test('the empty conversation retains the library and page-wide drop without a separate drop box', () => {
  const starters = patchBySource('apps/desktop/chat/src/components/ProjectStarters.tsx');
  assert.match(starters, /^ .*id: 'library'/m);
  assert.doesNotMatch(starters, /^\+.*(?:onDrop|id: 'community')/m);
  assert.match(app, /\+    document\.addEventListener\('drop', letGo\);/);
});

test('a dropped file keeps its path when the host can name it, and is copied otherwise', () => {
  const p = patchBySource('apps/desktop/chat/src/lib/desktop-attachments.ts');
  assert.match(p, /\+    const hostPath = \(window as unknown as \{ __no996HostPath\?: \(file: File\) => Promise<string> \}\)\.__no996HostPath;/);
  assert.match(p, /\+      for \(const \{ item, file \} of unknown\) keepBytes\(item, file\);/);
  assert.match(p, /\+        for \(const \{ item, file, path \} of found\) if \(!path\) keepBytes\(item, file\);/);
});
