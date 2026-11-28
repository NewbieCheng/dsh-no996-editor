import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBuiltinRhythm, resolveBuiltinBgmFile, sha256Buffer } from './builtin-bgm.mjs';
import { analyzeAudioSamples, extractMonoFloat32 } from './rhythm-analyzer.mjs';

export const MAX_SPOKEN_BGM_BYTES = 24 * 1024 * 1024;
const error = code => Object.assign(new Error(code), { code });

function audioExtension(bytes) {
  if (bytes.length < 12) return '';
  const starts = (ascii, at = 0) => bytes.subarray(at, at + ascii.length).toString('ascii') === ascii;
  if (starts('RIFF') && starts('WAVE', 8)) return 'wav';
  if (starts('ID3') || (bytes[0] === 255 && (bytes[1] & 224) === 224 && (bytes[1] & 6) !== 0)) return 'mp3';
  if (starts('fLaC')) return 'flac';
  if (starts('OggS')) return 'ogg';
  // Only these standalone containers; no text playlists or remote references.
  return '';
}

/** Resolve audio and measured beats before creating any project directory. */
export async function prepareSpokenBgm({ mode, upload, signal, resolveDefault = resolveBuiltinBgmFile,
  readDefaultRhythm = loadBuiltinRhythm, decode = extractMonoFloat32 } = {}) {
  signal?.throwIfAborted();
  if (!['none', 'default', 'upload'].includes(mode) || (mode !== 'upload' && upload !== undefined)) throw error('SPOKEN_BGM_INPUT');
  if (mode === 'none') return null;
  let bytes, analysis, extension;
  if (mode === 'default') {
    try {
      const { file, spec } = await resolveDefault('vibe-we-never', { signal });
      bytes = await readFile(file, { signal });
      // Verify the exact payload again before pairing it with the cached beats.
      if (sha256Buffer(bytes) !== spec.sha256) throw error('SPOKEN_BGM_UNAVAILABLE');
      analysis = readDefaultRhythm(spec.id);
      extension = 'mp3';
    } catch {
      signal?.throwIfAborted();
      throw error('SPOKEN_BGM_UNAVAILABLE');
    }
  } else {
    if (!Buffer.isBuffer(upload) || upload.length > MAX_SPOKEN_BGM_BYTES) throw error('SPOKEN_BGM_INPUT');
    bytes = Buffer.from(upload);
    extension = audioExtension(bytes);
    if (!extension) throw error('SPOKEN_BGM_INPUT');
    const scratch = await mkdtemp(join(tmpdir(), 'no996-spoken-bgm-'));
    try {
      const file = join(scratch, `music.${extension}`);
      await writeFile(file, bytes, { signal, flag: 'wx' });
      const { samples, sampleRate } = await decode(file, { signal });
      signal?.throwIfAborted();
      analysis = analyzeAudioSamples(samples, sampleRate);
    } catch {
      signal?.throwIfAborted();
      throw error('SPOKEN_BGM_DECODE_FAILED');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  signal?.throwIfAborted();
  if (!(analysis?.durationSec >= 0.1) || !Array.isArray(analysis.beats)) throw error(mode === 'default' ? 'SPOKEN_BGM_UNAVAILABLE' : 'SPOKEN_BGM_DECODE_FAILED');
  return { mode, bytes, analysis, path: `assets/audio/bgm/music.${extension}`, sha256: sha256Buffer(bytes), volume: 0.16 };
}
