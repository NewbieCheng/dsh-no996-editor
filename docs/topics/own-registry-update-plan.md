<!-- doc
id: topics-own-registry
reader: 想让 DSH「版本」区能正常更新的维护者
fact-source: 2026-11-19 对 DSH app.asar、pnpm view、GitLab/GitHub Packages packument 的实测
checked: 0.17.0
rot-if: DSH 版本检测字段或 registry 行为变化
-->

# 让 GUI 更新可用：自建静态 npm registry

## 为什么需要

DSH「插件详情 → 版本」用 `pnpm view <包名>@<版本>` 读取完整 packument，只有读到 `dsh.bundle` 才认为可安装。已实测：

- GitLab npm registry：不保存 `dsh` 等自定义字段；
- GitHub Packages：同样不保存（`pnpm view @newbiecheng/dsh-openfilm-probe@0.0.1 dsh` 无输出）；
- npmjs.org：会保存（对照 `@michengai/dsh-codex-ui`），但没有账号。

因此发布到 GitLab 的包在 GUI 里永远显示「没有声明组合包，无法安装」。CLI 安装不受影响。

## 静态 registry 方案（已验证可行）

`pnpm view` 实际发的是 `Accept: application/json` 的完整 packument 请求。用本地假服务返回手写 packument 后，`pnpm view @n996probe/pkg@1.2.3 dsh --json` 正确输出 `dsh.bundle`。所以只要网站能托管下面两个静态文件，就能替代 registry：

```
<网站根>/@newbiecheng%2fdsh-openfilm            -> packument.json（content-type: application/json）
<网站根>/@newbiecheng/dsh-openfilm/-/newbiecheng-dsh-openfilm-0.17.0.tgz -> 真实 tgz
```

packument 最小结构：

```json
{
  "name": "@newbiecheng/dsh-openfilm",
  "dist-tags": { "latest": "0.17.0" },
  "versions": {
    "0.17.0": {
      "name": "@newbiecheng/dsh-openfilm",
      "version": "0.17.0",
      "dist": {
        "tarball": "https://<你的网站>/@newbiecheng/dsh-openfilm/-/newbiecheng-dsh-openfilm-0.17.0.tgz",
        "shasum": "<tgz 的 sha1>"
      },
      "dsh": {
        "manifestVersion": 1,
        "bundle": { "patch": "./cordis.patch.yml" },
        "client": { "platform": "web", "immediately": true }
      },
      "engines": { "dsh": ">=0.2.0-rc.1 <0.3.0-0", "node": ">=22.2" },
      "dependencies": {}
    }
  },
  "time": { "0.17.0": "<ISO 时间>" }
}
```

注意：

1. URL 路径里的 scope 必须是 `%2f`（或服务器能正确解码的等价形式）；`pnpm view` 用 `GET /@newbiecheng%2fdsh-openfilm`。
2. packument 必须含 `dsh.bundle`、`engines.dsh`；完整 `dependencies` 建议照抄 tarball 里的 package.json，避免安装解析出错。
3. tarball 用 `scripts/pack-tgz.mjs` 的产物（约 122 MB），原样上传。
4. 静态站点要允许 `application/json` 和 `.tgz` 直链，不要加 HTML fallback。
5. 发布新版本时，把新 tgz 放上去、在 `versions` 增加条目、把 `dist-tags.latest` 指向新版本。旧版本条目保留，DSH 的「版本」区才能列出历史。

## DSH 侧配置

DSH 的 `pluginManager` 有 `registry` 配置项（一个 http(s) URL，默认 npmjs），把它设为你的网站根地址即可。GUI「添加插件」的安装源面板也允许自定义 registry。本机 `.npmrc` 的 `@newbiecheng:registry` 也要同步指向同一地址，以便 pnpm 安装解析。

## 待决定

- 你的网站域名与静态文件托管路径（能否放 122 MB tgz、能否返回 JSON content-type）。
- 是否公开访问；若需鉴权，DSH 的 registry 配置能否带 token（需实测）。
- 是否接受每次发版手工更新 packument（可用脚本自动生成）。

在本地确定这些信息前，不改 DSH 配置、不发布、不迁移用户安装。
