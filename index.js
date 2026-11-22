import { createDraftTool } from './src/tools/draft-tool.mjs';
import { createStudioController } from './src/studio/studio-controller.mjs';
import { startStudioProxy } from './src/studio/studio-proxy.mjs';
import { createWorkbenchAuth } from './src/auth/workbench-auth.mjs';
import { registerNo996LlmProvider } from './src/native/no996-llm-provider.mjs';
import { registerNo996WebProvider } from './src/native/no996-web-provider.mjs';

export const inject = ['tools', 'connection', 'webServer', 'llm', 'agentDefaultModel', 'storageDomain', 'sessionController', 'systemPrompt', 'agents'];

/** Register OpenFilm draft tool, No996 LLM/Web adapters, and the Studio host controller. */
export function apply(ctx) {
  // The packaged CLI (open --help) honors this: it prints the address instead of
  // opening a browser. Set on the Host process, so an agent that shells out to the
  // CLI still inherits it — the tool whitelist alone was bypassed that way.
  if (process.env.OPENFILM_NO_BROWSER == null) process.env.OPENFILM_NO_BROWSER = '1';
  // The packaged CLI starts its own Studio on 4747 when it can't find one; the
  // patched kernel reads this and refuses instead, so a shell-run `openfilm open`
  // cannot create a second Studio on the same project folder.
  if (process.env.NO996_EMBEDDED_STUDIO == null) process.env.NO996_EMBEDDED_STUDIO = '1';
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
  const llmReg = registerNo996LlmProvider(ctx, {
    auth: workbenchAuth,
    resolveAttachments: () => ctx.get?.('attachments'),
    resolveImageAccess: (attachments, ref) => {
      const fsSvc = ctx.get?.('fs');
      if (!attachments || typeof attachments.readImage !== 'function') return undefined;
      void loadResolveImageAccess();
      return fsSvc?.processPathFromHostPath?.(ref?.hostPath);
    },
    onWalletDirty,
  });
  ctx.effect(() => llmReg.dispose, 'no996: llm adapter');
  const webReg = registerNo996WebProvider(ctx, { auth: workbenchAuth, onWalletDirty });
  ctx.effect(() => webReg.dispose, 'no996: web providers');

  ctx.effect(
    () => createStudioController(ctx, startStudioProxy, {
      officialShell: process.env.NO996_OPENFILM_DSH_CHAT !== '1',
      workbenchAuth,
      onAuthChanged: () => {
        void webReg.refreshReady().catch(() => {});
        llmReg.refresh?.();
      },
      searchProvider: webReg.searchProvider,
      registerWalletDirtyListener: (fn) => { notifyControllerWalletDirty = fn; },
    }),
    'openfilm: Studio',
  );
}
