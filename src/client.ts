/** Figma REST API client with injected fetch for testability. Contract verified
 * against the official figma/rest-api-spec OpenAPI document. */

export interface FigmaClientOptions {
  /** Figma API root, for example https://api.figma.com/v1. */
  baseUrl?: string
  /** Figma personal access token. Prefer supplying it from a secret-backed config. */
  token?: string
  /** HTTP request timeout in milliseconds. 0 disables the timeout. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class FigmaError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'FigmaError'
  }
}

export interface FigmaUserInfo {
  userId: string
  handle: string
  email: string
}

export interface FigmaFileInfo {
  fileKey: string
  name: string
  role: string
  lastModified: string
  editorType: string
  thumbnailUrl: string
  version: string
  mainFileKey: string
  branchCount: number
}

export type FigmaNodeInfo = {
  id: string
  name: string
  type: string
  childCount: number
  children?: FigmaNodeInfo[]
}

export interface FigmaNodesResult {
  nodes: Array<{ nodeId: string; node: FigmaNodeInfo | null }>
  truncated: boolean
}

export interface FigmaImageInfo {
  nodeId: string
  url: string
}

export interface FigmaImagesResult {
  err: string
  images: FigmaImageInfo[]
}

export interface FigmaVersionInfo {
  id: string
  label: string
  description: string
  createdAt: string
  userHandle: string
}

export interface FigmaCommentInfo {
  id: string
  message: string
  userHandle: string
  createdAt: string
  resolvedAt: string
  nodeId: string
  parentId: string
}

export interface FigmaProjectInfo {
  id: string
  name: string
}

export interface FigmaProjectFileInfo {
  key: string
  name: string
  lastModified: string
}

const NAME_LIMIT = 200
const MESSAGE_LIMIT = 1000
const DESCRIPTION_LIMIT = 500
const IDS_LIMIT = 10
const NODE_BUDGET = 300
const NODE_DEPTH_MAX = 5
const LIST_LIMIT = 50
const COMMENT_LIMIT = 2000

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function asNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clampText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function encode(value: string): string {
  return encodeURIComponent(value)
}

function mapUserHandle(value: unknown): string {
  return clampText(asString(asRecord(value).handle), NAME_LIMIT)
}

function mapVersion(value: unknown): FigmaVersionInfo {
  const record = asRecord(value)
  return {
    id: asString(record.id),
    label: clampText(asString(record.label), NAME_LIMIT),
    description: clampText(asString(record.description), DESCRIPTION_LIMIT),
    createdAt: asString(record.created_at),
    userHandle: mapUserHandle(record.user),
  }
}

function mapComment(value: unknown): FigmaCommentInfo {
  const record = asRecord(value)
  const clientMeta = asRecord(record.client_meta)
  return {
    id: asString(record.id),
    message: clampText(asString(record.message), MESSAGE_LIMIT),
    userHandle: mapUserHandle(record.user),
    createdAt: asString(record.created_at),
    resolvedAt: asString(record.resolved_at),
    nodeId: asString(clientMeta.node_id),
    parentId: asString(record.parent_id),
  }
}

export class FigmaClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: FigmaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.figma.com/v1').replace(/\/+$/, '')
    this.token = options.token ?? ''
    this.timeoutMs = options.timeoutMs ?? 30000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  hasCredentials(): boolean {
    return Boolean(this.token)
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    options: { params?: Record<string, string | number | boolean | undefined>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!this.hasCredentials()) throw new FigmaError('Figma token not configured.', 401)
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = { accept: 'application/json', 'x-figma-token': this.token }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const controller = new AbortController()
    const combined = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    const timer = this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined
    try {
      const response = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: combined,
      })
      const raw = await response.text()
      let json: unknown = {}
      if (raw) {
        try { json = JSON.parse(raw) } catch { json = {} }
      }
      if (!response.ok) {
        const record = asRecord(json)
        const message = asString(record.err) || asString(record.message) || raw.slice(0, 300) || response.statusText
        throw new FigmaError(`Figma API ${method} ${path} returned HTTP ${response.status}: ${message}`, response.status)
      }
      return json as T
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async authTest(signal?: AbortSignal): Promise<FigmaUserInfo> {
    const raw = await this.request('GET', '/me', { signal })
    const record = asRecord(raw)
    return {
      userId: asString(record.id),
      handle: clampText(asString(record.handle), NAME_LIMIT),
      email: asString(record.email),
    }
  }

  async getFile(fileKey: string, options: { version?: string; signal?: AbortSignal } = {}): Promise<FigmaFileInfo> {
    const raw = await this.request('GET', `/files/${encode(fileKey)}`, { params: { version: options.version }, signal: options.signal })
    const record = asRecord(raw)
    return {
      fileKey,
      name: clampText(asString(record.name), NAME_LIMIT),
      role: asString(record.role),
      lastModified: asString(record.lastModified),
      editorType: asString(record.editorType),
      thumbnailUrl: asString(record.thumbnailUrl),
      version: asString(record.version),
      mainFileKey: asString(record.mainFileKey),
      branchCount: asArray(record.branches).length,
    }
  }

  async getFileNodes(
    fileKey: string,
    ids: string[],
    options: { depth?: number; version?: string; signal?: AbortSignal } = {},
  ): Promise<FigmaNodesResult> {
    const requested = ids.map(id => id.trim()).filter(Boolean).slice(0, IDS_LIMIT)
    if (!requested.length) throw new FigmaError('ids must contain at least one node ID.', 400)
    const depth = clampInt(options.depth, 0, NODE_DEPTH_MAX) ?? 2
    const raw = await this.request('GET', `/files/${encode(fileKey)}/nodes`, {
      params: { ids: requested.join(','), depth, version: options.version },
      signal: options.signal,
    })
    const record = asRecord(raw)
    const nodesRecord = asRecord(record.nodes)
    const budget = { count: NODE_BUDGET }
    const nodes = Object.entries(nodesRecord).map(([nodeId, value]) => ({
      nodeId,
      node: this.trimNode(asRecord(asRecord(value).document), depth, budget),
    }))
    return { nodes, truncated: budget.count <= 0 }
  }

  private trimNode(value: unknown, depth: number, budget: { count: number }): FigmaNodeInfo | null {
    const record = asRecord(value)
    const id = asString(record.id)
    const type = asString(record.type)
    if (!id || !type || budget.count <= 0) return null
    budget.count -= 1
    const childrenRaw = asArray(record.children)
    const node: FigmaNodeInfo = {
      id,
      name: clampText(asString(record.name), NAME_LIMIT),
      type,
      childCount: childrenRaw.length,
    }
    if (depth > 0 && childrenRaw.length) {
      const children: FigmaNodeInfo[] = []
      for (const child of childrenRaw) {
        if (budget.count <= 0) break
        const trimmed = this.trimNode(child, depth - 1, budget)
        if (trimmed) children.push(trimmed)
      }
      node.children = children
    }
    return node
  }

  async getImages(
    fileKey: string,
    ids: string[],
    options: { format?: string; scale?: number; version?: string; signal?: AbortSignal } = {},
  ): Promise<FigmaImagesResult> {
    const requested = ids.map(id => id.trim()).filter(Boolean).slice(0, IDS_LIMIT)
    if (!requested.length) throw new FigmaError('ids must contain at least one node ID.', 400)
    const format = options.format && ['jpg', 'png', 'svg', 'pdf'].includes(options.format) ? options.format : 'png'
    const scaleHundredths = options.scale === undefined ? undefined : clampInt(options.scale * 100, 1, 400)
    const raw = await this.request('GET', `/images/${encode(fileKey)}`, {
      params: {
        ids: requested.join(','),
        format,
        scale: scaleHundredths === undefined ? undefined : scaleHundredths / 100,
        version: options.version,
      },
      signal: options.signal,
    })
    const record = asRecord(raw)
    const images = Object.entries(asRecord(record.images))
      .map(([nodeId, url]) => ({ nodeId, url: asString(url) }))
      .filter(image => image.url)
    return { err: asString(record.err), images }
  }

  async getFileVersions(
    fileKey: string,
    options: { pageSize?: number; before?: string; after?: string; signal?: AbortSignal } = {},
  ): Promise<{ versions: FigmaVersionInfo[]; nextPage: number }> {
    const raw = await this.request('GET', `/files/${encode(fileKey)}/versions`, {
      params: { page_size: clampInt(options.pageSize, 1, LIST_LIMIT), before: options.before, after: options.after },
      signal: options.signal,
    })
    const record = asRecord(raw)
    const pagination = asRecord(record.pagination)
    return {
      versions: asArray(record.versions).map(mapVersion).slice(0, LIST_LIMIT),
      nextPage: asNumber(pagination, 'next_page'),
    }
  }

  async listComments(fileKey: string, signal?: AbortSignal): Promise<FigmaCommentInfo[]> {
    const raw = await this.request('GET', `/files/${encode(fileKey)}/comments`, { signal })
    return asArray(asRecord(raw).comments).map(mapComment).slice(0, LIST_LIMIT)
  }

  async postComment(fileKey: string, message: string, signal?: AbortSignal): Promise<FigmaCommentInfo> {
    const raw = await this.request('POST', `/files/${encode(fileKey)}/comments`, {
      body: { message: clampText(message, COMMENT_LIMIT) },
      signal,
    })
    return mapComment(raw)
  }

  async listTeamProjects(teamId: string, signal?: AbortSignal): Promise<{ teamName: string; projects: FigmaProjectInfo[] }> {
    const raw = await this.request('GET', `/teams/${encode(teamId)}/projects`, { signal })
    const record = asRecord(raw)
    return {
      teamName: clampText(asString(record.name), NAME_LIMIT),
      projects: asArray(record.projects)
        .map(project => {
          const item = asRecord(project)
          return { id: asString(item.id), name: clampText(asString(item.name), NAME_LIMIT) }
        })
        .filter(project => project.id)
        .slice(0, LIST_LIMIT),
    }
  }

  async listProjectFiles(projectId: string, options: { branchData?: boolean; signal?: AbortSignal } = {}): Promise<{ projectName: string; files: FigmaProjectFileInfo[] }> {
    const raw = await this.request('GET', `/projects/${encode(projectId)}/files`, {
      params: { branch_data: options.branchData },
      signal: options.signal,
    })
    const record = asRecord(raw)
    return {
      projectName: clampText(asString(record.name), NAME_LIMIT),
      files: asArray(record.files)
        .map(file => {
          const item = asRecord(file)
          return {
            key: asString(item.key),
            name: clampText(asString(item.name), NAME_LIMIT),
            lastModified: asString(item.last_modified),
          }
        })
        .filter(file => file.key)
        .slice(0, LIST_LIMIT),
    }
  }
}
