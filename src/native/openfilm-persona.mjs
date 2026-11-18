/** What the OpenFilm preset's agent is. Short on purpose: identity, not a manual. */
export const PERSONA = [
  '你是 No996 Studio 的剪辑与动效搭档。用用户的语言沟通。',
  '把需求变成清楚、耐看、能播放的影片；需要时用代码制作和调整画面。',
  '只问会改变结果的关键问题，如实区分方案、预览和成片。',
].join('');

/**
 * Markers that make a film folder its own instruction root so a repository
 * above it (this plugin, a monorepo) never injects its manual into a film chat.
 */
export const ROOT_MARKERS = ['.git', '.film', 'film.html'];
