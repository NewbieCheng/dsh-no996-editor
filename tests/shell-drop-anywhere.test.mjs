// "素材丢这里" was a promise the page kept nowhere: only the composer card took
// files, so every other pixel showed the system's "no entry" cursor. The patches
// below make the whole chat take a file and give it a real path when the desktop
// window can name one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = path => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const app = read('patches/010-App.patch');
const patch = name => read(`patches/${name}`);

test('the chat takes a file anywhere in the page', () => {
  assert.match(app, /\+    const hasFiles = \(data: DataTransfer \| null\) =>/);
  assert.match(app, /\+    document\.addEventListener\('drop', letGo\);/);
  assert.match(app, /\+      attachFiles\(filesFromTransfer\(event\.dataTransfer\), \{ x: event\.clientX, y: event\.clientY \}\);/);
  // the composer's own handler must win: it knows where the caret is
  assert.match(app, /\+      if \(!hasFiles\(event\.dataTransfer\) \|\| event\.defaultPrevented\) return;/);
  // a hover with an empty type list still has to be accepted, or the OS refuses the drop
  assert.match(app, /\+      if \(!event\.dataTransfer\) return;\n\+      event\.preventDefault\(\);/);
});

test('the drop box is a real drop target and a picker', () => {
  const p = patch('070-ProjectStarters.patch');
  assert.match(p, /\+      <label/);
  assert.match(p, /\+        onDrop=\{\(event\) => \{/);
  assert.match(p, /\+          takeFiles\(files\);/);
  assert.match(p, /\+          if \(!files \|\| !files\.length\) return;/);
  assert.match(p, /\+        <input\n\+          type="file"/);
  assert.match(p, /\+      <\/label>/);
});

test('a dropped file keeps its path when the host can name it, and is copied otherwise', () => {
  const p = patch('180-desktop-attachments.patch');
  assert.match(p, /\+    const hostPath = \(window as unknown as \{ __no996HostPath\?: \(file: File\) => Promise<string> \}\)\.__no996HostPath;/);
  assert.match(p, /\+      for \(const \{ item, file \} of unknown\) keepBytes\(item, file\);/);
  assert.match(p, /\+        for \(const \{ item, file, path \} of found\) if \(!path\) keepBytes\(item, file\);/);
});
