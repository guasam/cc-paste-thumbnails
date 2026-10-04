import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptEditInput, PromptEditResult } from 'claude-code'

const BAND = {
  plugin: 'cc-paste-thumbnails',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

// The first 24 bytes of a 1280×720 PNG as `od -An -tu1 -N24` prints them
const PNG_HEAD = ' 137  80  78  71  13  10  26  10   0   0   0  13  73  72  68  82\n   0   0   5   0   0   0   2 208\n'

// Stands in for the shell, osascript and sips (or wl-paste and od on Linux) beneath the plugin
const world = (on: On, os = 'Darwin') => {
  const clock = mock.clock(on)
  const ran: string[][] = []
  on('process.run', ($, e) => {
    ran.push([...e.argv])
    const out = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[0] === 'uname') return out(`${os}\n`)
    // The clipboard script gets the target path after `sh -c <script> sh`
    if (e.argv[0] === 'sh') return out(e.argv.length > 4 ? 'ok' : '/tmp/cc-paste-thumbnails')
    if (e.argv[0] === 'od') return out(PNG_HEAD)
    if (e.argv[0] === 'osascript') return out('ok\n')
    if (e.argv[0] === 'sips') return out(`${e.argv[5]}\n  pixelWidth: 1280\n  pixelHeight: 720\n`)

    return out('')
  })
  // The engine's own band: an empty box
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return h(Box, { key: 'engine' }) as never
  })
  // The editor itself: applies the splice
  on('prompt.edit', ($, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)

    return { text, cursor: e.start + e.inputText.length }
  })

  return { clock, ran }
}

// prompt.edit is raised by the editor, not typed as a call on the test's $
const edit = ($: Engine, input: Omit<PromptEditInput, 'origin'>) =>
  ($.prompt as unknown as { edit: (e: PromptEditInput) => Promise<PromptEditResult> }).edit({
    origin: { kind: 'composer' },
    ...input,
  })

const type = ($: Engine, text: string, inputText: string) =>
  edit($, { text, cursor: text.length, start: text.length, end: text.length, inputText })

test('a pasted image shows as a thumbnail above the prompt', async ($, on) => {
  const { clock } = world(on)

  await type($, 'look at ', '[Image #1]')
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toEqual({ file: expect.stringMatching(/^\/tmp\/cc-paste-thumbnails\/\d+-1\.png$/), format: 'png' })
  expect((await ui.find({ type: 'Text', text: /#1 1280×720/ }))?.text).toContain('1280×720')
  await ui.unmount()
})

test('on Linux the clipboard is read with wl-paste or xclip and sized from the PNG header', async ($, on) => {
  const { clock, ran } = world(on, 'Linux')

  await type($, 'look at ', '[Image #1]')
  await clock.advance(0)

  expect(ran.some(argv => argv[0] === 'osascript' || argv[0] === 'sips')).toBe(false)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /#1 1280×720/ }))?.text).toContain('1280×720')
  await ui.unmount()
})

test('deleting the placeholder hides it, undo brings it back without a new capture', async ($, on) => {
  const { clock, ran } = world(on)

  await type($, '', '[Image #1]')
  await clock.advance(0)
  const grabs = () => ran.filter(argv => argv[0] === 'osascript').length
  expect(grabs()).toBe(1)

  await edit($, { text: '[Image #1]', cursor: 10, start: 0, end: 10, inputText: '' })
  const empty = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await empty.find({ type: 'Image' })).toBeUndefined()
  await empty.unmount()

  await type($, '', '[Image #1]')
  await clock.advance(0)
  expect(grabs()).toBe(1)
  const back = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await back.find({ type: 'Image' })).toBeDefined()
  await back.unmount()
})

test('submitting clears the thumbnails', async ($, on) => {
  const { clock } = world(on)
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)

  await type($, '', '[Image #1]')
  await clock.advance(0)
  await $.prompt.submit({ text: '[Image #1]', wait: false, origin: { kind: 'composer' } })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
})

test('desktop shows text chips instead of pictures', async ($, on) => {
  const { clock } = world(on)

  await type($, '', '[Image #1] and [Image #2]')
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Text', text: /#\d 1280×720/ })).toHaveLength(2)
  await ui.unmount()
})

test('a placeholder that lands without an edit event is caught by the poll', async ($, on) => {
  const { clock } = world(on)
  let draft = ''
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('session.start', () => ({ cwd: '/tmp' }))

  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
  draft = 'see [Image #1]'
  await clock.advance(500)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await ui.unmount()
})

test('a non-interactive session does not poll', async ($, on) => {
  const { clock } = world(on)
  let reads = 0
  on('prompt.read', () => {
    reads += 1

    return { value: { text: '[Image #1]', cursor: 10 } }
  })
  on('session.start', () => ({ cwd: '/tmp' }))

  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false } as never)
  await clock.advance(2000)

  expect(reads).toBe(0)
})
