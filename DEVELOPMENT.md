# dsh-tool-figma 开发文档

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 项目名 | `dsh-tool-figma` |
| 定位 | DeepSeek Harness 的 Figma 设计上下文插件 |
| 版本 | v0.1.0 |
| 架构 | Cordis 插件 + `ctx.tools.register(defineTool(...))` |
| API | Figma REST API v1（契约核对自官方 `figma/rest-api-spec` OpenAPI 文档） |
| 认证 | `X-Figma-Token` 请求头，令牌从环境变量读取 |

### 1.1 目录

```text
src/client.ts        FigmaClient：fetch 注入、超时、AbortSignal、错误映射、节点裁剪与限长
src/index.ts         9 个 defineTool 定义与插件 apply
 tests/client.spec.ts 客户端认证、端点、脱敏、裁剪、限长、错误测试
 tests/tools.spec.ts  工具注册、render、写操作 kind 与端到端测试
examples/cordis.yml  dsh 组合配置示例
```

## 2. 技术决策

### 2.1 端点契约（2026-10 对照官方 OpenAPI 核对）

- `GET /me` → `{ id, handle, img_url, email }`。
- `GET /files/{key}`（query: version/ids/depth/geometry/plugin_data/branch_data）→ 元数据 + `document`；本插件只转发元数据，不转发 document/components/styles。
- `GET /files/{key}/nodes?ids=`（逗号分隔，单参数）→ `{ nodes: { [id]: { document, ... } } }`。
- `GET /images/{key}?ids=&format=&scale=` → `{ err, images: { [id]: url|null } }`；空 URL 表示渲染中。
- `GET /files/{key}/versions?page_size=&before=&after=` → `{ versions, pagination }`。
- `GET/POST /files/{key}/comments` → POST 请求体 `{ message }`（必填，可带 comment_id/client_meta）。
- `GET /teams/{id}/projects` → `{ name, projects: [{id, name}] }`；`GET /projects/{id}/files` → `{ name, files: [{key, name, thumbnail_url, last_modified}] }`。
- 错误体为 `{ err, status }`，客户端优先取 `err` 字段。

### 2.2 脱敏与裁剪

- 文件元数据不返回 document/components/styles；节点树递归裁剪只保留 id/name/type/childCount/children，深度默认 2、上限 5，总节点预算 300，超限置 `truncated`。
- 版本描述 500 字符、评论消息 1000 字符、评论发布 2000 字符上限；列表统一 50 条上限；单次节点 ID 上限 10。
- `img_url`/`thumbnail_url` 不进入工具输出；images 只返回 nodeId 与渲染 URL。

### 2.3 工具范围

- 读：auth_test、get_file、get_file_nodes、get_images、get_file_versions、list_file_comments、list_team_projects、list_project_files。
- 写：post_comment（单条评论，`kind: 'edit'`）。
- 不做：文件修改、删除、webhook、variables、dev resources、库分析。

## 3. 测试

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试覆盖 X-Figma-Token 请求头、文件元数据脱敏、节点树裁剪与预算、ids 上限、images 参数钳制、版本/评论限长、POST 评论路径、团队项目与项目文件映射、HTTP 错误映射、工具注册、render、写操作 kind 与端到端执行。

## 4. 后续方向

- 增加 dev resources 只读工具。
- 增加 components/styles 团队库查询。
- 跟随 Figma API 变化补充兼容性测试。
