import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FigmaClient, FigmaError } from './client.js'

export const name = 'dsh-tool-figma'
export const inject = ['tools']

export interface FigmaPluginConfig {
  baseUrl?: string
  /** Environment variable containing the Figma personal access token. */
  tokenEnv?: string
  timeoutMs?: number
}

export function apply(ctx: Context, config: FigmaPluginConfig = {}) {
  const tokenEnv = config.tokenEnv ?? 'FIGMA_TOKEN'
  const client = new FigmaClient({
    baseUrl: config.baseUrl,
    token: process.env[tokenEnv],
    timeoutMs: config.timeoutMs,
  })
  for (const tool of createTools(client)) ctx.tools.register(tool)
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function unavailable(reason: string) {
  return { found: false, items: [], reason }
}

function errorReason(error: unknown): string {
  return error instanceof FigmaError ? error.message : error instanceof Error ? error.message : String(error)
}

function splitIds(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

const NODE_RENDER_LIMIT = 60
const LIST_RENDER_LIMIT = 30

function renderUser(value: { ok?: boolean; reason?: string; handle?: string; email?: string; userId?: string }) {
  return value.ok
    ? text(`Figma authenticated as ${value.handle ?? ''} (${value.email ?? ''}) user=${value.userId ?? ''}`)
    : text(`Figma authentication failed: ${value.reason ?? ''}`)
}

function renderFile(value: { found?: boolean; reason?: string; fileKey?: string; name?: string; role?: string; lastModified?: string; editorType?: string; version?: string; branchCount?: number }) {
  if (!value.found) return text(value.reason ?? 'Figma file not found.')
  return text(`${value.name ?? ''} (${value.fileKey ?? ''}) role=${value.role ?? ''} editor=${value.editorType ?? ''} version=${value.version ?? ''} branches=${value.branchCount ?? 0} lastModified=${value.lastModified ?? ''}`)
}

function renderNode(node: { id?: string; name?: string; type?: string; childCount?: number; children?: Array<Record<string, unknown>> }, depth: number, lines: string[]): void {
  if (lines.length >= NODE_RENDER_LIMIT) return
  lines.push(`${'  '.repeat(depth)}${node.id ?? ''} [${node.type ?? ''}] ${node.name ?? ''}${node.childCount ? ` (${node.childCount} children)` : ''}`)
  for (const child of node.children ?? []) renderNode(child as { id?: string; name?: string; type?: string; childCount?: number; children?: Array<Record<string, unknown>> }, depth + 1, lines)
}

function renderNodes(value: { found?: boolean; reason?: string; truncated?: boolean; nodes?: Array<{ nodeId?: string; node?: Record<string, unknown> | null }> }) {
  if (!value.found) return text(value.reason ?? 'Figma nodes unavailable.')
  const lines: string[] = []
  for (const entry of value.nodes ?? []) {
    lines.push(`${entry.nodeId}:`)
    if (entry.node) renderNode(entry.node as Parameters<typeof renderNode>[0], 1, lines)
    else lines.push('  (not found)')
  }
  if (value.truncated) lines.push('[node tree truncated by budget]')
  return text(lines.join('\n'))
}

function renderImages(value: { found?: boolean; reason?: string; err?: string; images?: Array<{ nodeId?: string; url?: string }> }) {
  if (!value.found) return text(value.reason ?? 'Figma image render unavailable.')
  if (value.err) return text(`Figma image render error: ${value.err}`)
  if (!value.images?.length) return text('No rendered image URLs yet.')
  return text(value.images.map(image => `${image.nodeId ?? ''} -> ${image.url ?? ''}`).join('\n'))
}

function renderVersions(value: { found?: boolean; reason?: string; versions?: Array<{ id?: string; label?: string; description?: string; createdAt?: string; userHandle?: string }>; nextPage?: number }) {
  if (!value.found) return text(value.reason ?? 'Figma versions unavailable.')
  if (!value.versions?.length) return text('No file versions found.')
  const lines = value.versions.map(version => `${version.id ?? ''} ${version.label || '(unlabeled)'} ${version.createdAt ?? ''} by ${version.userHandle ?? ''}${version.description ? `\n  ${version.description}` : ''}`)
  if (value.nextPage) lines.push(`next_page=${value.nextPage}`)
  return text(lines.join('\n'))
}

function renderComments(items: Array<{ id?: string; message?: string; userHandle?: string; createdAt?: string; nodeId?: string; resolvedAt?: string }>) {
  if (!items.length) return text('No comments found.')
  return text(items.map(comment => [
    `${comment.id ?? ''} ${comment.userHandle ?? ''} ${comment.createdAt ?? ''}${comment.nodeId ? ` node=${comment.nodeId}` : ''}${comment.resolvedAt ? ' resolved' : ''}`,
    `  ${comment.message ?? ''}`,
  ].join('\n')).join('\n'))
}

function renderProjects(items: Array<{ id?: string; name?: string }>) {
  if (!items.length) return text('No projects found.')
  return text(items.map(project => `${project.id ?? ''} ${project.name ?? ''}`).join('\n'))
}

function renderProjectFiles(items: Array<{ key?: string; name?: string; lastModified?: string }>) {
  if (!items.length) return text('No files found.')
  return text(items.map(file => `${file.key ?? ''} ${file.name ?? ''} lastModified=${file.lastModified ?? ''}`).join('\n'))
}

export function createTools(client: FigmaClient) {
  return [
    defineTool({
      name: 'figma_auth_test',
      description: 'Verify the configured Figma personal access token without returning it.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, handle: { type: 'string' }, email: { type: 'string' }, userId: { type: 'string' } } },
        render: (_args, value) => renderUser(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Verify Figma credentials', kind: 'read' } },
      async execute(_args, exec) {
        try { return { ok: true, ...await client.authTest(exec?.signal) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'figma_get_file',
      description: "Get one Figma file's metadata. The document node tree, components, and styles are intentionally not returned.",
      parameters: { fileKey: { type: 'string', required: true, description: 'Figma file key from the file URL' }, version: { type: 'string', description: 'Specific version ID' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, fileKey: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, lastModified: { type: 'string' }, editorType: { type: 'string' }, thumbnailUrl: { type: 'string' }, version: { type: 'string' }, mainFileKey: { type: 'string' }, branchCount: { type: 'number' } } },
        render: (_args, value) => renderFile(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Figma file ${args.fileKey ?? ''}`, kind: 'read' } },
      async execute(args, exec) {
        if (!args.fileKey) return { found: false, reason: 'fileKey is required.' }
        try { return { found: true, ...await client.getFile(args.fileKey as string, { version: args.version as string, signal: exec?.signal }) } }
        catch (error) { return { found: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'figma_get_file_nodes',
      description: 'Get trimmed node trees (id, name, type, children) for up to 10 node IDs. Other node properties are never returned.',
      parameters: {
        fileKey: { type: 'string', required: true, description: 'Figma file key' },
        ids: { type: 'string', required: true, description: 'Comma-separated node IDs, e.g. 1:2,3:4 (max 10)' },
        depth: { type: 'integer', description: 'Tree depth to traverse, 0-5 (default 2)' },
        version: { type: 'string', description: 'Specific version ID' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, truncated: { type: 'boolean' }, nodes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { nodeId: { type: 'string' }, node: { type: 'object', additionalProperties: true } } } } } },
        render: (_args, value) => renderNodes(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Figma nodes ${args.fileKey ?? ''}`, kind: 'read' } },
      async execute(args, exec) {
        if (!args.fileKey) return unavailable('fileKey is required.')
        const ids = splitIds(args.ids)
        if (!ids.length) return unavailable('ids must contain at least one comma-separated node ID.')
        try { return { found: true, ...await client.getFileNodes(args.fileKey as string, ids, { depth: args.depth as number, version: args.version as string, signal: exec?.signal }).then(result => ({ truncated: result.truncated, nodes: result.nodes.map(({ nodeId, node }) => ({ nodeId, node: node ?? undefined })) })) } }
        catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'figma_get_images',
      description: 'Render up to 10 nodes as images and return their download URLs. Rendering is async; empty results mean still processing.',
      parameters: {
        fileKey: { type: 'string', required: true, description: 'Figma file key' },
        ids: { type: 'string', required: true, description: 'Comma-separated node IDs (max 10)' },
        format: { type: 'string', description: 'Image format: jpg, png, svg, or pdf (default png)' },
        scale: { type: 'number', description: 'Image scale, 0.01-4 (default 1)' },
        version: { type: 'string', description: 'Specific version ID' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, err: { type: 'string' }, images: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { nodeId: { type: 'string' }, url: { type: 'string' } } } } } },
        render: (_args, value) => renderImages(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Render Figma nodes ${args.fileKey ?? ''}`, kind: 'read' } },
      async execute(args, exec) {
        if (!args.fileKey) return unavailable('fileKey is required.')
        const ids = splitIds(args.ids)
        if (!ids.length) return unavailable('ids must contain at least one comma-separated node ID.')
        try { return { found: true, ...await client.getImages(args.fileKey as string, ids, { format: args.format as string, scale: args.scale as number, version: args.version as string, signal: exec?.signal }) } }
        catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'figma_get_file_versions',
      description: "List one Figma file's version history metadata.",
      parameters: {
        fileKey: { type: 'string', required: true, description: 'Figma file key' },
        pageSize: { type: 'integer', description: 'Versions per page, 1-50' },
        before: { type: 'string', description: 'Return versions before this version ID' },
        after: { type: 'string', description: 'Return versions after this version ID' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, versions: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, createdAt: { type: 'string' }, userHandle: { type: 'string' } } } }, nextPage: { type: 'number' } } },
        render: (_args, value) => renderVersions(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Figma versions ${args.fileKey ?? ''}`, kind: 'read' } },
      async execute(args, exec) {
        if (!args.fileKey) return { found: false, reason: 'fileKey is required.' }
        try { return { found: true, ...await client.getFileVersions(args.fileKey as string, { pageSize: args.pageSize as number, before: args.before as string, after: args.after as string, signal: exec?.signal }) } }
        catch (error) { return { found: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'figma_list_file_comments',
      description: 'List comments on one Figma file. Comment messages are capped.',
      parameters: { fileKey: { type: 'string', required: true, description: 'Figma file key' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, items: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, message: { type: 'string' }, userHandle: { type: 'string' }, createdAt: { type: 'string' }, resolvedAt: { type: 'string' }, nodeId: { type: 'string' }, parentId: { type: 'string' } } } } } },
        render: (_args, value) => !value.found ? text(value.reason ?? 'Figma comments unavailable.') : renderComments(value.items ?? []),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Figma comments ${args.fileKey ?? ''}`, kind: 'search' } },
      async execute(args, exec) {
        if (!args.fileKey) return unavailable('fileKey is required.')
        try { return { found: true, items: await client.listComments(args.fileKey as string, exec?.signal) } }
        catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'figma_post_comment',
      description: 'Post one comment on a Figma file. WRITE operation; single comment only.',
      parameters: {
        fileKey: { type: 'string', required: true, description: 'Figma file key' },
        message: { type: 'string', required: true, description: 'Comment message (max 2000 characters)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, id: { type: 'string' }, message: { type: 'string' }, userHandle: { type: 'string' }, createdAt: { type: 'string' } } },
        render: (_args, value) => value.ok
          ? text(`Comment ${value.id ?? ''} posted by ${value.userHandle ?? ''} at ${value.createdAt ?? ''}`)
          : text(`Figma comment failed: ${value.reason ?? ''}`),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Comment on ${args.fileKey ?? ''}`, kind: 'edit' } },
      async execute(args, exec) {
        if (!args.fileKey || !args.message) return { ok: false, reason: 'fileKey and message are required.' }
        try { return { ok: true, ...await client.postComment(args.fileKey as string, args.message as string, exec?.signal) } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'figma_list_team_projects',
      description: 'List projects in one Figma team.',
      parameters: { teamId: { type: 'string', required: true, description: 'Figma team ID' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, teamName: { type: 'string' }, projects: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' } } } } } },
        render: (_args, value) => !value.found ? text(value.reason ?? 'Figma projects unavailable.') : text(`team=${value.teamName ?? ''}\n${renderProjects(value.projects ?? [])[0].text}`),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Figma projects ${args.teamId ?? ''}`, kind: 'search' } },
      async execute(args, exec) {
        if (!args.teamId) return unavailable('teamId is required.')
        try { return { found: true, ...await client.listTeamProjects(args.teamId as string, exec?.signal) } }
        catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'figma_list_project_files',
      description: "List files in one Figma project.",
      parameters: { projectId: { type: 'string', required: true, description: 'Figma project ID' }, branchData: { type: 'boolean', description: 'Include branch metadata' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, projectName: { type: 'string' }, files: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, name: { type: 'string' }, lastModified: { type: 'string' } } } } } },
        render: (_args, value) => !value.found ? text(value.reason ?? 'Figma files unavailable.') : text(`project=${value.projectName ?? ''}\n${renderProjectFiles(value.files ?? [])[0].text}`),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Figma project files ${args.projectId ?? ''}`, kind: 'search' } },
      async execute(args, exec) {
        if (!args.projectId) return unavailable('projectId is required.')
        try { return { found: true, ...await client.listProjectFiles(args.projectId as string, { branchData: args.branchData as boolean, signal: exec?.signal }) } }
        catch (error) { return unavailable(errorReason(error)) }
      },
    }),
  ]
}
