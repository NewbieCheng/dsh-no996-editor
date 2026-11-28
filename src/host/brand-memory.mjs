import { BRAND_DISPLAYS, BRAND_LOGO_LIMIT, BRAND_PLACEMENTS, brandFields, parseBrandLogo } from '../film/project-brand.mjs';

const initial = { enabled: false, name: '', identity: '', placement: 'auto', logoBase64: null };

/** Private per-profile settings. Only the settings surface requests the full
 * record; the normal edit surface can request a summary without identity/logo. */
export async function openBrandMemory(storageDomain, z) {
  const schema = z.object({
    enabled: z.boolean(), name: z.string().max(80), identity: z.string().max(600),
    placement: z.enum(BRAND_PLACEMENTS), logoBase64: z.string().max(Math.ceil(BRAND_LOGO_LIMIT / 3) * 4).nullable(),
    configured: z.boolean().optional(), display: z.enum(BRAND_DISPLAYS).optional(),
  }).strict();
  const domain = await storageDomain.open({ name: 'no996_brand_memory', version: 1, layout: 'single', tables: {}, global: { schema, initial } });
  let queue = Promise.resolve();
  const full = () => {
    const record = domain.global.get();
    return { ...record, configured: record.configured ?? Boolean(record.enabled || record.name || record.identity || record.logoBase64) };
  };
  return {
    full,
    summary() {
      const { enabled, name, logoBase64 } = full();
      return { enabled, name, hasLogo: Boolean(logoBase64) };
    },
    dismissSetup() {
      const save = queue.then(async () => {
        const current = full();
        if (!current.configured) await domain.global.set({ ...current, configured: true });
      });
      queue = save.then(() => {}, () => {});
      return save;
    },
    save(input) {
      const settings = brandFields(input);
      const updateLogo = Object.hasOwn(input, 'logoBase64');
      const logo = input.logoBase64;
      if (updateLogo && logo !== null) parseBrandLogo(logo);
      const save = queue.then(async () => {
        const value = { ...settings, logoBase64: updateLogo ? logo : full().logoBase64, configured: true };
        await domain.global.set(value);
        return { ...value };
      });
      queue = save.then(() => {}, () => {});
      return save;
    },
    async close() { await queue; await domain.close(); },
  };
}
