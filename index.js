import { createDraftTool } from './src/tools/draft-tool.mjs';
import { createStudioController } from './src/studio/studio-controller.mjs';
import { startStudioProxy } from './src/studio/studio-proxy.mjs';
import { createWorkbenchAuth } from './src/auth/workbench-auth.mjs';
import { registerNo996LlmProvider } from './src/native/no996-llm-provider.mjs';
import { registerNo996WebProvider } from './src/native/no996-web-provider.mjs';

export const inject = ['tools', 'connection', 'webServer', 'llm', 'agentDefaultModel', 'storageDomain', 'sessionController', 'systemPrompt', 'agents'];

/** Register OpenFilm draft tool, No996 LLM/Web adapters, and the Studio host controller. */
export function apply(ctx) {
  const workbenchAuth = createWorkbenchAuth({ dev: process.env.NO996_OPENFILM_DEV === '1' });
  let resolveAttachmentsMod;
  const loadResolveImageAccess = async () => {
    if (!resolveAttachmentsMod) {
      resolveAttachmentsMod = import('@deepseek-ai/dsh-llm').catch(() => null);
    }
    return resolveAttachmentsMod;
  };
  let notifyControllerWalletDirty = () => {};
  const onWalletDirty = (reason) => {
    try { notifyControllerWalletDirty(reason); } catch { /* ignore */ }
  };

  ctx.effect(() => ctx.tools.register(createDraftTool()), 'openfilm: draft tool');
  ctx.effect(
    () => registerNo996LlmProvider(ctx, {
      auth: workbenchAuth,
      resolveAttachments: () => ctx.get?.('attachments'),
      resolveImageAccess: (attachments, ref) => {
        const fsSvc = ctx.get?.('fs');
        if (!attachments || typeof attachments.readImage !== 'function') return undefined;
        void loadResolveImageAccess();
        return fsSvc?.processPathFromHostPath?.(ref?.hostPath);
      },
      onWalletDirty,
    }),
    'no996: llm adapter',
  );
  const webReg = registerNo996WebProvider(ctx, { auth: workbenchAuth, onWalletDirty });
  ctx.effect(() => webReg.dispose, 'no996: web providers');

  ctx.effect(
    () => createStudioController(ctx, startStudioProxy, {
      officialShell: process.env.NO996_OPENFILM_DSH_CHAT !== '1',
      workbenchAuth,
      onAuthChanged: () => { void webReg.refreshReady().catch(() => {}); },
      registerWalletDirtyListener: (fn) => { notifyControllerWalletDirty = fn; },
    }),
    'openfilm: Studio',
  );
}
