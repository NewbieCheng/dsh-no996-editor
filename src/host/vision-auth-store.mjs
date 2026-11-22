/**
 * Scoped user authorization store for destructive / side-effect vision operations
 * (single-frame vs whole-clip cutout, avatar placement vs background removal).
 *
 * Authorizations bind tightly to `(projectId, conversation, assetId, operation,
 * sourceRevision)` so:
 *  - a model cannot forge `confirmed: true` without a Host-recorded approval;
 *  - an approval for one asset, conversation, project, or file revision never
 *    carries over to another;
 *  - installing models, template slots, or uploading talking-head footage never
 *    grants cutout permission.
 */
import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export const VISION_OPERATIONS = new Set(['cutout_preview', 'cutout_apply', 'avatar_layout']);
export const VISION_SCOPES = new Set(['single_frame', 'whole_clip']);

export async function computeSourceRevision(projectPath, assetPath) {
  try {
    const info = await stat(join(projectPath, ...assetPath.split(/[\\/]/)));
    return createHash('sha256')
      .update(`${assetPath}:${info.size}:${Math.round(info.mtimeMs)}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return '';
  }
}

export function createVisionAuthStore() {
  // Key: `${projectId}\0${conversation}\0${assetId}\0${operation}`
  const grants = new Map();

  const makeKey = ({ projectId, conversation, assetId, operation }) =>
    `${String(projectId || '')}\0${String(conversation || '')}\0${String(assetId || '')}\0${String(operation || '')}`;

  function authorize({
    projectId,
    conversation = '',
    assetId,
    operation = 'cutout_preview',
    scope = 'single_frame',
    sourceRevision = '',
    grantedBy = 'user_action',
  } = {}) {
    if (!projectId || !assetId || !VISION_OPERATIONS.has(operation) || !VISION_SCOPES.has(scope)) {
      throw Object.assign(new Error('无效的视觉授权参数'), { code: 'INVALID_VISION_AUTH' });
    }
    if (grantedBy !== 'user_action' && grantedBy !== 'explicit_turn') {
      throw Object.assign(new Error('仅受信任的用户动作或明确指令可授予视觉处理权限'), { code: 'UNTRUSTED_VISION_GRANT' });
    }
    const record = Object.freeze({
      grantId: randomUUID(),
      projectId: String(projectId),
      conversation: String(conversation || ''),
      assetId: String(assetId),
      operation,
      scope,
      sourceRevision: String(sourceRevision || ''),
      grantedBy,
      grantedAt: Date.now(),
    });
    grants.set(makeKey(record), record);
    return record;
  }

  function verify({
    projectId,
    conversation = '',
    assetId,
    operation = 'cutout_preview',
    requiredScope = 'single_frame',
    sourceRevision = '',
  } = {}) {
    const key = makeKey({ projectId, conversation, assetId, operation });
    const record = grants.get(key);
    if (!record) return { ok: false, reason: 'CONFIRMATION_REQUIRED' };
    if (record.sourceRevision && sourceRevision && record.sourceRevision !== sourceRevision) {
      return { ok: false, reason: 'STALE_SOURCE_REVISION' };
    }
    if (requiredScope === 'whole_clip' && record.scope !== 'whole_clip') {
      return { ok: false, reason: 'SINGLE_FRAME_ONLY' };
    }
    return { ok: true, grant: record };
  }

  function revoke({ projectId, conversation = '', assetId, operation } = {}) {
    if (operation) {
      grants.delete(makeKey({ projectId, conversation, assetId, operation }));
      return;
    }
    for (const op of VISION_OPERATIONS) {
      grants.delete(makeKey({ projectId, conversation, assetId, operation: op }));
    }
  }

  return { authorize, verify, revoke };
}
