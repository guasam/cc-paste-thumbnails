import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Thumb } from '../types'
import { CLIPBOARD_SCRIPT, THUMB_ROWS, parseSips, placeholders, thumbColumns } from './thumbs'

// Every image captured for the current draft, kept even when its placeholder
// is deleted so an undo brings the same picture back
const thumbs = atom({ plugin: 'cc-paste-thumbnails', key: 'thumbs' } as const, [])
// The image numbers whose placeholders are in the draft right now
const shown = atom({ plugin: 'cc-paste-thumbnails', key: 'shown' } as const, [])

let dir: string | undefined
const pending = new Set<number>()

async function tempDir($: EngineInterface) {
  if (dir === undefined) {
    const { stdout } = await $.process.run([
      'sh',
      '-c',
      'd="${TMPDIR:-/tmp}/cc-paste-thumbnails" && mkdir -p "$d" && printf %s "$d"',
    ])
    dir = stdout.replace(/\/+$/, '')
  }

  return dir
}

function settle($: EngineInterface, n: number, patch: Partial<Thumb>) {
  return update($, thumbs, list => list.map(one => (one.n === n ? { ...one, ...patch } : one)))
}

async function capture($: EngineInterface, n: number) {
  try {
    const path = `${await tempDir($)}/${Date.now()}-${n}.png`
    const grab = await $.process.run(['osascript', '-', path], { stdin: CLIPBOARD_SCRIPT, timeoutMs: 5000 })
    if (grab.exitCode !== 0 || grab.stdout.trim() !== 'ok') {
      await settle($, n, { status: 'missing' })

      return
    }

    const sips = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path])
    await settle($, n, { status: 'ready', path, ...parseSips(sips.stdout) })
  } catch {
    await settle($, n, { status: 'missing' })
  } finally {
    pending.delete(n)
  }
}

async function clear($: EngineInterface) {
  lastText = undefined
  const paths = (await read($, thumbs)).flatMap(one => (one.path ? [one.path] : []))
  await update($, thumbs, () => [])
  await update($, shown, () => [])
  if (paths.length > 0) {
    $.clock.after(0, () => void $.process.run(['rm', '-f', ...paths]))
  }
}

// The draft as last synced, so a poll tick that finds it unchanged does nothing
let lastText: string | undefined

// Matches the band to the `[Image #N]` placeholders in the draft, capturing any new ones
async function sync($: EngineInterface, text: string) {
  if (text === lastText) {
    return
  }
  lastText = text

  const present = placeholders(text)
  const before = await read($, shown)
  if (present.join() === before.join()) {
    return
  }

  const known = new Set((await read($, thumbs)).map(one => one.n))
  const fresh = present.filter(n => !known.has(n) && !pending.has(n))

  if (fresh.length > 0) {
    const loading: Thumb[] = fresh.map(n => ({ n, status: 'loading' }))
    await update($, thumbs, list => [...list, ...loading])
    for (const n of fresh) {
      pending.add(n)
      // Read the clipboard after the edit lands so the paste never waits on it
      $.clock.after(0, () => void capture($, n))
    }
  }
  await update($, shown, () => present)
}

let polling = false

async function poll($: EngineInterface) {
  if (polling) {
    return
  }
  polling = true
  try {
    await sync($, (await $.prompt.read()).text)
  } catch {
    // No prompt box right now (a dialog, a reload mid-read); the next tick tries again
  } finally {
    polling = false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // An image paste lands in the draft without a prompt.edit, so watch the box too
    if (e.isInteractive) {
      $.clock.every(400, () => void poll($))
    }

    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await sync($, box.text)

    return box
  })

  on('prompt.submit', async ($, e, next) => {
    await clear($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await clear($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const visible = await read($, shown)
    if (e.props.hasSurvey || visible.length === 0) {
      return next(e)
    }

    const list = (await read($, thumbs)).filter(one => visible.includes(one.n)).sort((a, b) => a.n - b.n)
    if (list.length === 0) {
      return next(e)
    }

    const caption = (one: Thumb) =>
      one.status === 'loading'
        ? `#${one.n} …`
        : one.status === 'missing'
          ? `#${one.n} no preview`
          : one.width && one.height
            ? `#${one.n} ${one.width}×${one.height}`
            : `#${one.n}`

    if (e.surface === 'terminal') {
      const { Box, Image, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {list.map(one => {
            const columns = Math.min(thumbColumns(one.width, one.height), e.props.bodyColumns)

            return (
              <Box key={`t${one.n}`} flexDirection="column" width={Math.max(columns, caption(one).length)}>
                {one.status === 'ready' && one.path ? (
                  <Image
                    key={`img${one.n}`}
                    source={{ file: one.path, format: 'png' }}
                    columns={columns}
                    rows={THUMB_ROWS}
                    alt={`[Image #${one.n}]`}
                  />
                ) : (
                  <Box height={THUMB_ROWS} width={columns} borderStyle="round" borderDimColor />
                )}
                <Text dimColor wrap="truncate-end">
                  {caption(one)}
                </Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {list.map(one => (
          <Text key={`t${one.n}`} dimColor>
            🖼 {caption(one)}
          </Text>
        ))}
      </Box>
    )
  })
}
