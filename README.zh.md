# dsh-tool-figma

[English](README.md) | [中文](README.zh.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Figma 设计上下文 Cordis 插件。Agent 可以查看文件元数据、裁剪后的节点树、节点渲染图、版本历史和评论，并可发布单条评论——同时令牌和重型设计数据不会进入工具输出。

## 安装

```sh
npm install @libai168/dsh-tool-figma
```

需要 peer dependency：`@deepseek-ai/cordis`（^4.0.1）和 `@deepseek-ai/dsh-tools`（^0.1.0-rc.6）。

## 配置

```yaml
- name: 'github:LJH-snow/dsh-tool-figma'
  config:
    # baseUrl: 'https://api.figma.com/v1'
    tokenEnv: 'FIGMA_TOKEN'
    # timeoutMs: 30000
```

插件从 `tokenEnv` 指定的环境变量读取 Figma 个人访问令牌（默认 `FIGMA_TOKEN`）。不要把可用令牌写入源码、示例、测试或提交的配置文件。令牌在 Figma 的 **Settings > Security > Personal access tokens** 创建，并只授予部署所需权限（至少 *File content: read*；`figma_post_comment` 需要 *Write comments*）。

## 工具

| 工具 | 说明 | 写操作 |
|---|---|---|
| `figma_auth_test` | 验证令牌，不回显 | 否 |
| `figma_get_file` | 读取单个文件元数据（不含 document） | 否 |
| `figma_get_file_nodes` | 读取最多 10 个节点的裁剪节点树 | 否 |
| `figma_get_images` | 渲染最多 10 个节点并返回下载 URL | 否 |
| `figma_get_file_versions` | 查看文件版本历史 | 否 |
| `figma_list_file_comments` | 查看文件评论 | 否 |
| `figma_post_comment` | 发布单条评论 | 是 |
| `figma_list_team_projects` | 列出团队项目 | 否 |
| `figma_list_project_files` | 列出项目内文件 | 否 |

## 安全契约

- 令牌在插件启动时从环境变量读取，不进入工具返回值或渲染文本。
- `figma_get_file` 只返回元数据；document 树、组件、样式和缩略图数据一律不转发。
- 节点树只保留 `id`、`name`、`type`、`childCount`、`children`，深度默认 2、上限 5，总节点预算 300；fills、样式等其余属性全部丢弃。
- 列表上限 50 条（单次节点 ID 最多 10 个）；版本描述截断 500 字符、评论消息截断 1000 字符。
- 只有 `figma_post_comment` 是写操作（标记 `kind: 'edit'`）；不提供删除、文件修改或团队管理工具。
- 调用方取消信号会传递给 `fetch`，默认请求超时 30 秒。
- API 错误会规范化为 `{ ok: false, reason }` 或 `{ found: false, reason }`。

## API 范围

当前版本使用经官方 `figma/rest-api-spec` OpenAPI 文档核对的端点：`/me`、`/files/{key}`、`/files/{key}/nodes`、`/images/{key}`、`/files/{key}/versions`、`/files/{key}/comments`（GET/POST）、`/teams/{id}/projects`、`/projects/{id}/files`。Webhook、变量、dev resources、库分析和文件修改类接口有意未包含。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## 许可证

[MIT](LICENSE)
