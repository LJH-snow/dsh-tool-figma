import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FigmaClient, FigmaError } from '../src/client.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const testToken = process.env.FIGMA_TEST_TOKEN ?? `figd-test-${randomUUID()}`

function client(fetchImpl: ReturnType<typeof vi.fn>) {
  return new FigmaClient({ baseUrl: 'https://figma.test.invalid/v1', token: testToken, fetchImpl })
}

describe('FigmaClient', () => {
  it('authenticates with the X-Figma-Token header and maps the user', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'u-1', handle: 'alice', img_url: 'https://img.example.invalid/a.png', email: 'alice@example.invalid' }))
    const result = await client(fetchImpl).authTest()

    expect(result).toEqual({ userId: 'u-1', handle: 'alice', email: 'alice@example.invalid' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://figma.test.invalid/v1/me')
    expect((init.headers as Record<string, string>)['x-figma-token']).toBe(testToken)
    expect(JSON.stringify(result)).not.toContain(testToken)
  })

  it('returns file metadata only and never the document payload', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      name: 'Design System', role: 'owner', lastModified: '2026-10-05T00:00:00Z', editorType: 'figma',
      thumbnailUrl: 'https://thumb.example.invalid/t.png', version: 'v-9', document: { DO_NOT_EXPOSE: true },
      components: { SECRET: true }, styles: {}, linkAccess: 'inherit', mainFileKey: 'main-1',
      branches: [{ key: 'b1' }, { key: 'b2' }],
    }))
    const result = await client(fetchImpl).getFile('abc123')

    expect(result).toEqual({
      fileKey: 'abc123', name: 'Design System', role: 'owner', lastModified: '2026-10-05T00:00:00Z',
      editorType: 'figma', thumbnailUrl: 'https://thumb.example.invalid/t.png', version: 'v-9',
      mainFileKey: 'main-1', branchCount: 2,
    })
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE')
    expect(JSON.stringify(result)).not.toContain('SECRET')
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://figma.test.invalid/v1/files/abc123')
  })

  it('trims node trees to id, name, type, and children within budget', async () => {
    const document = {
      id: '0:1', name: 'Page', type: 'PAGE',
      children: [{
        id: '1:1', name: 'Frame A', type: 'FRAME', fills: 'DO_NOT_EXPOSE',
        children: [{ id: '2:1', name: 'Text', type: 'TEXT' }],
      }],
    }
    const fetchImpl = vi.fn(async () => jsonResponse({ name: 'DS', nodes: { '0:1': { document } } }))
    const result = await client(fetchImpl).getFileNodes('abc123', ['0:1'], { depth: 3 })

    expect(result.nodes[0].nodeId).toBe('0:1')
    expect(result.nodes[0].node).toEqual({
      id: '0:1', name: 'Page', type: 'PAGE', childCount: 1,
      children: [{ id: '1:1', name: 'Frame A', type: 'FRAME', childCount: 1, children: [{ id: '2:1', name: 'Text', type: 'TEXT', childCount: 0 }] }],
    })
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE')
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://figma.test.invalid/v1/files/abc123/nodes?ids=0%3A1&depth=3')
  })

  it('rejects empty node id lists and clamps the list length', async () => {
    const many = Array.from({ length: 20 }, (_, index) => `${index}`)
    const fetchImpl = vi.fn(async () => jsonResponse({ name: 'DS', nodes: {} }))
    await expect(client(fetchImpl).getFileNodes('abc123', [])).rejects.toThrow(FigmaError)
    await client(fetchImpl).getFileNodes('abc123', many)
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toContain('ids=0%2C1%2C2')
    expect(url).not.toContain(',10')
  })

  it('renders images with format and clamped scale', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ err: null, images: { '1:1': 'https://cdn.example.invalid/a.png', '1:2': null } }))
    const result = await client(fetchImpl).getImages('abc123', ['1:1', '1:2'], { format: 'png', scale: 9 })

    expect(result).toEqual({ err: '', images: [{ nodeId: '1:1', url: 'https://cdn.example.invalid/a.png' }] })
    const [url] = fetchImpl.mock.calls[0] as [string]
    expect(url).toBe('https://figma.test.invalid/v1/images/abc123?ids=1%3A1%2C1%3A2&format=png&scale=4')
  })

  it('lists versions and comments with capped mapping', async () => {
    const longDescription = 'd'.repeat(3000)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ versions: [{ id: 'v1', label: 'Release', description: longDescription, created_at: '2026-10-01', user: { id: 'u', handle: 'bob' } }], pagination: { next_page: 2 } }))
      .mockResolvedValueOnce(jsonResponse({ comments: [{ id: 'c1', message: 'm'.repeat(2000), user: { id: 'u', handle: 'bob' }, created_at: '2026-10-02', resolved_at: '2026-10-03', client_meta: { node_id: '5:5' }, parent_id: 'c0' }] }))
    const fire = client(fetchImpl)
    const versions = await fire.getFileVersions('abc123')
    const comments = await fire.listComments('abc123')

    expect(versions.versions[0]).toEqual({ id: 'v1', label: 'Release', description: 'd'.repeat(500), createdAt: '2026-10-01', userHandle: 'bob' })
    expect(versions.nextPage).toBe(2)
    expect(comments[0]).toEqual({ id: 'c1', message: 'm'.repeat(1000), userHandle: 'bob', createdAt: '2026-10-02', resolvedAt: '2026-10-03', nodeId: '5:5', parentId: 'c0' })
    const [versionsUrl] = fetchImpl.mock.calls[0] as [string]
    expect(versionsUrl).toBe('https://figma.test.invalid/v1/files/abc123/versions')
  })

  it('posts one comment with POST and a message body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'c9', message: 'Looks good', user: { id: 'u', handle: 'alice' }, created_at: '2026-10-05T01:00:00Z' }))
    const result = await client(fetchImpl).postComment('abc123', 'Looks good')

    expect(result).toMatchObject({ id: 'c9', message: 'Looks good', userHandle: 'alice' })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://figma.test.invalid/v1/files/abc123/comments')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ message: 'Looks good' })
  })

  it('lists team projects and project files, and maps HTTP errors', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ name: 'Platform', projects: [{ id: 'p1', name: 'Web' }] }))
      .mockResolvedValueOnce(jsonResponse({ name: 'Web', files: [{ key: 'k1', name: 'Landing', thumbnail_url: 'https://x.example.invalid/t.png', last_modified: '2026-10-04' }] }))
      .mockResolvedValueOnce(jsonResponse({ err: 'Invalid token', status: 403 }, 403))
    const fire = client(fetchImpl)

    const projects = await fire.listTeamProjects('team-1')
    expect(projects).toEqual({ teamName: 'Platform', projects: [{ id: 'p1', name: 'Web' }] })
    const files = await fire.listProjectFiles('p1')
    expect(files).toEqual({ projectName: 'Web', files: [{ key: 'k1', name: 'Landing', lastModified: '2026-10-04' }] })
    await expect(fire.authTest()).rejects.toThrow('Invalid token')
    await expect(new FigmaClient({}).authTest()).rejects.toThrow(FigmaError)
  })
})
