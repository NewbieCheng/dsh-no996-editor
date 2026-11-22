/**
 * Workbench-scoped ASR choice resolution (`unset | off | local:sensevoice-small | remote:<id>`).
 *
 * Stored strictly inside No996 Workbench preferences (`$DSH_HOME/no996-openfilm/preferences.json`),
 * never touching DSH global voice/ASR preferences or ordinary DSH conversations.
 *
 * Rules:
 *  - `unset` resolves read-only to `local:sensevoice-small` if SenseVoice weights + runtime are ready.
 *  - Explicit `off` or `remote:<id>` is never overwritten on startup or background install.
 *  - When `local:sensevoice-small` is chosen and weights are missing/corrupt, it stays selected
 *    and reports `unavailable` rather than silently falling back to a remote cloud provider.
 *  - Dictation never sends microphone audio to a remote cloud provider.
 */
import { SENSE_VOICE } from '../asr/asr-models.mjs';
import { resolveFfmpeg } from '../asr/asr-audio.mjs';

export function createAsrChoiceResolver({ preferences, transcribeService } = {}) {
  async function localSenseVoiceReadiness() {
    const sv = await transcribeService.status().catch(() => ({ ready: false, engine: 'MISSING' }));
    let ffmpegOk = false;
    try { await resolveFfmpeg(); ffmpegOk = true; } catch { ffmpegOk = false; }
    const engineOk = sv.engine === 'ready';
    const ready = sv.ready === true && engineOk && ffmpegOk;
    return {
      ready,
      weightsReady: sv.ready === true,
      engine: sv.engine || 'MISSING',
      ffmpegOk,
      installing: Boolean(sv.installing),
      bytesTotal: Number(sv.bytesTotal) || SENSE_VOICE.bytes,
      bytesOnDisk: Number(sv.bytesOnDisk) || 0,
      progress: Number(sv.progress) || 0,
      error: sv.error || '',
      dir: sv.dir || '',
    };
  }

  async function resolve({ purpose = 'media' } = {}) {
    const prefs = await preferences.get();
    const configured = prefs.asrChoice || 'unset';
    const local = await localSenseVoiceReadiness();

    if (configured === 'off') {
      return {
        configured,
        effective: 'off',
        available: false,
        reason: 'TURNED_OFF',
        message: '工作台语音转写已关闭',
        local,
      };
    }

    if (configured.startsWith('remote:')) {
      if (purpose === 'dictation') {
        return {
          configured,
          effective: configured,
          available: false,
          reason: 'DICTATION_LOCAL_REQUIRED',
          message: '语音听写仅支持本地模型；当前媒体转写已选云端，不会将麦克风录音发送到云端。请切换到「本地 · SenseVoice」。',
          local,
        };
      }
      return {
        configured,
        effective: configured,
        available: true,
        reason: '',
        message: '将上传音频至所选云端服务并按其规则计费',
        local,
      };
    }

    if (configured === 'local:sensevoice-small' || (configured === 'unset' && local.ready)) {
      const available = local.ready;
      return {
        configured,
        effective: 'local:sensevoice-small',
        available,
        reason: available ? '' : (!local.weightsReady ? 'MODEL_MISSING' : !local.engineOk ? 'ENGINE_MISSING' : 'FFMPEG_MISSING'),
        message: available
          ? '本地 · SenseVoice 已就绪（音频不出本机）'
          : !local.weightsReady
            ? '本地 · SenseVoice 权重缺失（不可用 · 请重新下载或更换）'
            : !local.engineOk
              ? `本地识别引擎不可用（${local.engine}）`
              : '缺少 FFmpeg，无法解码音频',
        local,
      };
    }

    return {
      configured,
      effective: 'unset',
      available: false,
      reason: 'MODEL_MISSING',
      message: '尚未启用本地语音模型（下载并启用 SenseVoice 后即可使用）',
      local,
    };
  }

  async function setChoice(choice) {
    const next = await preferences.set({ asrChoice: choice });
    return { choice: next.asrChoice, ...(await resolve()) };
  }

  async function enableLocalAfterInstall() {
    const prefs = await preferences.get();
    if (prefs.asrChoice === 'unset') {
      await preferences.set({ asrChoice: 'local:sensevoice-small' });
    }
    return resolve();
  }

  return { resolve, setChoice, enableLocalAfterInstall, localSenseVoiceReadiness };
}
