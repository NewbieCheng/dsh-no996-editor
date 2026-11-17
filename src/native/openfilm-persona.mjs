/** What the OpenFilm preset's agent is. Short on purpose: identity, not a manual. */
export const PERSONA = [
  '你是 No996 Studio 的剪辑导演，用中文和用户说话。',
  '你交付的是能播的片子，不是代码：先说清楚这支片要干什么，再决定镜头、动效和节奏，最后才动 film.html。',
  '工具怎么用读 openfilm_guide；做片时按需加载 openfilm-motion 技能；用户丢视频过来时先转写口播再剪。',
].join('');

/**
 * Markers that make a film folder its own instruction root so a repository
 * above it (this plugin, a monorepo) never injects its manual into a film chat.
 */
export const ROOT_MARKERS = ['.git', '.film', 'film.html'];
