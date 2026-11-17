/**
 * `openfilm_generate_image`: generate an image via No996 workbench `/v1/images/generations`
 * (using the protected system default API Key on Host) and import it straight into the
 * OpenFilm project via Studio so it gets indexed and can be referenced from `film.html`.
 */

const text = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);

export function createImageGenTool({ isProjectAgent, projectOf, http, studioBridge }) {
  return {
    name: 'openfilm_generate_image',
    description: 'Generate an image through the connected 不加班 workbench (billed by credits) and save it directly into the project under assets/image/. Returns the relative path to reference in film.html.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Detailed visual prompt for the generated image.' },
        aspect_ratio: {
          type: 'string',
          enum: ['16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '1:1', '21:9'],
          description: 'Aspect ratio of the generated image (defaults to 16:9).',
        },
        out: {
          type: 'string',
          description: 'Base file name without directory or extension (e.g. hero_cover).',
        },
        model: {
          type: 'string',
          description: 'Optional image model id (defaults to auto).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof isProjectAgent !== 'function' || isProjectAgent(exec?.agent) !== true) {
        throw new Error('This tool is available only to a conversation bound to an OpenFilm project.');
      }
      const project = projectOf?.(exec.agent);
      if (!project?.projectId) throw new Error('This conversation is not bound to an OpenFilm project.');
      const prompt = text(args?.prompt);
      if (!prompt) throw new Error('prompt is required.');
      if (!studioBridge || typeof studioBridge.generateImage !== 'function') {
        throw new Error('不加班生图服务未就绪。');
      }

      const result = await studioBridge.generateImage({
        prompt,
        ratio: text(args?.aspect_ratio) || '16:9',
        out: text(args?.out),
        model: text(args?.model) || 'auto',
      }, { signal: exec?.signal });

      const generated = result?.files?.[0];
      if (!generated?.path || !(generated.bytes instanceof Uint8Array)) {
        throw new Error('生图未返回有效图像字节。');
      }

      const filesUrl = `/api/projects/${encodeURIComponent(project.projectId)}/files`;
      const landed = await http().put(filesUrl, {
        query: { path: generated.path },
        raw: generated.bytes,
        type: 'image/png',
      });
      const where = typeof landed?.path === 'string' ? landed.path : generated.path;
      const usedModel = result?.receipt?.model || 'auto';
      const usedSize = result?.receipt?.size || '';
      return {
        text: `已通过不加班工作台生成图片并入库：${where}（模型：${usedModel}${usedSize ? `，尺寸：${usedSize}` : ''}）。在 film.html 中可直接引用此相对路径。`,
      };
    },
  };
}
