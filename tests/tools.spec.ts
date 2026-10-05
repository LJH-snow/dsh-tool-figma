import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { FigmaClient } from '../src/client.ts'
import { createTools } from '../src/index.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const clientForTest = () => new FigmaClient({ token: process.env.FIGMA_TEST_TOKEN ?? `figd-test-${randomUUID()}` })

describe('dsh-tool-figma tools', () => {
  it('registers the Figma tool set', () => {
    expect(createTools(clientForTest()).map(tool => tool.name)).toEqual([
      'figma_auth_test',
      'figma_get_file',
      'figma_get_file_nodes',
      'figma_get_images',
      'figma_get_file_versions',
      'figma_list_file_comments',
      'figma_post_comment',
      'figma_list_team_projects',
      'figma_list_project_files',
    ])
  })

  it('renders file, nodes, images, and list results', () => {
    const tools = createTools(clientForTest())
    const file = tools.find(item => item.name === 'figma_get_file')!
    const fileView = file.output.render({}, {
      found: true, fileKey: 'abc123', name: 'Design System', role: 'owner', editorType: 'figma',
      version: 'v-9', branchCount: 2, lastModified: '2026-10-05',
    }) as Array<{ text: string }>
    expect(fileView[0].text).toContain('Design System (abc123) role=owner editor=figma version=v-9 branches=2')

    const nodes = tools.find(item => item.name === 'figma_get_file_nodes')!
    const nodesView = nodes.output.render({}, {
      found: true,
      nodes: [{ nodeId: '0:1', node: { id: '0:1', name: 'Page', type: 'PAGE', childCount: 1, children: [{ id: '1:1', name: 'Frame A', type: 'FRAME', childCount: 0 }] } }],
    }) as Array<{ text: string }>
    expect(nodesView[0].text).toContain('0:1:')
    expect(nodesView[0].text).toContain('0:1 [PAGE] Page (1 children)')
    expect(nodesView[0].text).toContain('1:1 [FRAME] Frame A')

    const images = tools.find(item => item.name === 'figma_get_images')!
    const imagesView = images.output.render({}, {
      found: true, images: [{ nodeId: '1:1', url: 'https://cdn.example.invalid/a.png' }],
    }) as Array<{ text: string }>
    expect(imagesView[0].text).toContain('1:1 -> https://cdn.example.invalid/a.png')

    const comments = tools.find(item => item.name === 'figma_list_file_comments')!
    const commentsView = comments.output.render({}, {
      found: true,
      items: [{ id: 'c1', message: 'Looks good', userHandle: 'bob', createdAt: '2026-10-02', nodeId: '5:5', resolvedAt: '' }],
    }) as Array<{ text: string }>
    expect(commentsView[0].text).toContain('c1 bob 2026-10-02 node=5:5')
    expect(commentsView[0].text).toContain('Looks good')
  })

  it('marks post_comment as an edit and renders write results', () => {
    const tools = createTools(clientForTest())
    const post = tools.find(item => item.name === 'figma_post_comment')!
    expect(post.presentCall({ fileKey: 'abc123', message: 'hi' })).toMatchObject({ kind: 'edit' })
    const readTool = tools.find(item => item.name === 'figma_get_file')!
    expect(readTool.presentCall({ fileKey: 'abc123' })).toMatchObject({ kind: 'read' })

    const postView = post.output.render({}, { ok: true, id: 'c9', userHandle: 'alice', createdAt: '2026-10-05' }) as Array<{ text: string }>
    expect(postView[0].text).toContain('Comment c9 posted by alice')
    const failureView = post.output.render({}, { ok: false, reason: 'fileKey and message are required.' }) as Array<{ text: string }>
    expect(failureView[0].text).toContain('Figma comment failed')
  })

  it('executes file metadata through the tool layer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      name: 'Design System', role: 'owner', lastModified: '2026-10-05', editorType: 'figma',
      thumbnailUrl: '', version: 'v-1', document: { DO_NOT_EXPOSE: true }, branches: [],
    }))
    const tools = createTools(new FigmaClient({ token: `figd-test-${randomUUID()}`, fetchImpl }))
    const file = tools.find(item => item.name === 'figma_get_file')!
    const result = await file.execute({ fileKey: 'abc123' })
    expect(result).toMatchObject({ found: true, name: 'Design System', branchCount: 0 })
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
