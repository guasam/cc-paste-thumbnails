const PLACEHOLDER = /\[Image #(\d+)\]/g

export const THUMB_ROWS = 6

// The image numbers whose `[Image #N]` placeholders are in the draft
export const placeholders = (text: string): number[] => {
  const found = new Set<number>()
  for (const match of text.matchAll(PLACEHOLDER)) {
    found.add(Number(match[1]))
  }

  return [...found].sort((a, b) => a - b)
}

// Terminal cells are roughly twice as tall as wide, so keep the aspect ratio
// with a fixed height and a width of about 2 columns per row of height
export const thumbColumns = (width?: number, height?: number): number => {
  if (!width || !height) {
    return THUMB_ROWS * 2
  }

  return Math.min(28, Math.max(6, Math.round((THUMB_ROWS * 2 * width) / height)))
}

export const parseSips = (stdout: string): { width?: number; height?: number } => {
  const width = /pixelWidth:\s*(\d+)/.exec(stdout)?.[1]
  const height = /pixelHeight:\s*(\d+)/.exec(stdout)?.[1]

  return {
    width: width ? Number(width) : undefined,
    height: height ? Number(height) : undefined,
  }
}

// Reads the size from the IHDR chunk of a PNG, given `od -An -tu1 -N24` of its first 24 bytes
export const parsePngHeader = (stdout: string): { width?: number; height?: number } => {
  const bytes = stdout.trim().split(/\s+/).map(Number)
  if (bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') {
    return {}
  }

  const word = (at: number) => bytes.slice(at, at + 4).reduce((n, b) => n * 256 + b, 0)

  return { width: word(16), height: word(20) }
}

// Reads the clipboard's PNG into the file named by $1 with wl-paste (Wayland) or
// xclip (X11, XWayland); prints "ok" or "none"
export const LINUX_CLIPBOARD_SCRIPT = `f="$1"
{ [ -n "$WAYLAND_DISPLAY" ] && wl-paste --type image/png > "$f"; } 2>/dev/null ||
  xclip -selection clipboard -t image/png -o > "$f" 2>/dev/null
if [ -s "$f" ]; then printf ok; else rm -f "$f"; printf none; fi
`

// Reads the clipboard's PNG into the file named by argv[1]; prints "ok" or "none"
export const CLIPBOARD_SCRIPT = `on run argv
  try
    set img to the clipboard as «class PNGf»
  on error
    return "none"
  end try
  set f to open for access (POSIX file (item 1 of argv)) with write permission
  try
    set eof f to 0
    write img to f
  end try
  close access f
  return "ok"
end run
`
