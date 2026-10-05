# dsh-tool-figma

[English](README.md) | [中文](README.zh.md)

Figma design context integration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a Cordis plugin. The agent can inspect file metadata, trimmed node trees, rendered node images, version history, and comments, and post a single comment — while the token and heavy design payloads stay out of tool output.

## Install

```sh
npm install @libai168/dsh-tool-figma
```

Requires `@deepseek-ai/cordis` (^4.0.1) and `@deepseek-ai/dsh-tools` (^0.1.0-rc.6) as peer dependencies.

## Configuration

```yaml
- name: 'github:LJH-snow/dsh-tool-figma'
  config:
    # baseUrl: 'https://api.figma.com/v1'
    tokenEnv: 'FIGMA_TOKEN'
    # timeoutMs: 30000
```

The plugin reads the Figma personal access token from the environment variable named by `tokenEnv` (default: `FIGMA_TOKEN`). Do not put a usable token in source, examples, tests, or committed configuration. Create the token in Figma under **Settings > Security > Personal access tokens** and grant only the scopes your deployment needs (at minimum *File content: read*; *Write comments* is required for `figma_post_comment`).

## Tools

| Tool | Description | Write |
|---|---|---|
| `figma_auth_test` | Verify the token without returning it | No |
| `figma_get_file` | Read one file's metadata (no document payload) | No |
| `figma_get_file_nodes` | Read trimmed node trees for up to 10 node IDs | No |
| `figma_get_images` | Render up to 10 nodes and return download URLs | No |
| `figma_get_file_versions` | List version history metadata | No |
| `figma_list_file_comments` | List file comments | No |
| `figma_post_comment` | Post one comment | Yes |
| `figma_list_team_projects` | List projects in a team | No |
| `figma_list_project_files` | List files in a project | No |

## Security contract

- The token is read from an environment variable at plugin startup and is never included in tool output or rendered text.
- `figma_get_file` returns metadata only; the document tree, components, styles, and thumbnail payloads are intentionally not forwarded.
- Node trees are trimmed to `id`, `name`, `type`, `childCount`, and `children` with a depth cap (default 2, max 5) and a 300-node budget; fills, styles, and all other node properties are dropped.
- Lists are capped at 50 entries (10 node IDs per call); version descriptions are capped at 500 characters and comment messages at 1,000 characters.
- Only `figma_post_comment` is a write tool (marked `kind: 'edit'`); there are no delete, file-mutation, or team-management tools.
- The client passes caller cancellation signals through to `fetch` and uses a 30-second timeout by default.
- API failures are normalized into `{ ok: false, reason }` or `{ found: false, reason }` tool results.

## API scope

This version uses the Figma REST API endpoints verified against the official `figma/rest-api-spec` OpenAPI document: `/me`, `/files/{key}`, `/files/{key}/nodes`, `/images/{key}`, `/files/{key}/versions`, `/files/{key}/comments` (GET and POST), `/teams/{id}/projects`, and `/projects/{id}/files`. Webhooks, variables, dev resources, library analytics, and file mutations are intentionally not included.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## License

[MIT](LICENSE)
