import { spawn } from 'child_process'
import { existsSync, readdirSync } from 'graceful-fs'
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  writeFile
} from 'fs/promises'
import { basename, join, resolve } from 'path'
import { parse as plistParse, type PlistObject } from 'plist'
import { parseMajorVersion, readBundleVersion } from './d3dmetal'

const WINE_LIB = join('Contents', 'Resources', 'wine', 'lib')
const WINE_BIN = join('Contents', 'Resources', 'wine', 'bin', 'wine64')
const FRAMEWORK = join('external', 'D3DMetal.framework')
const MARKER = join('Contents', 'Resources', 'heroic-d3dmetal.json')
/** Where a toolkit is assembled, hidden from the runner list until it is complete */
const STAGING = '.importing'

/** D3DMetal 3 is the first release that runs DLSS on MetalFX */
const MIN_D3DMETAL = 3

export interface ImportedToolkit {
  /** Folder name, which is also the name Heroic shows for the runner */
  name: string
  path: string
  d3dmetalVersion: string
  /** The installed toolkit whose Wine the new one uses */
  base: string
}

interface ToolkitMarker {
  d3dmetal: string
  base: string
  source: string
  imported: string
}

function run(command: string, args: string[], input = ''): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => (stdout += data.toString()))
    child.stderr.on('data', (data: Buffer) => (stderr += data.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else
        reject(
          new Error(
            `${basename(command)} ${args[0]} failed (${code}): ${stderr.trim()}`
          )
        )
    })
    child.stdin.end(input)
  })
}

/** The volume an `hdiutil attach -plist` or `hdiutil info -plist` entry mounted */
function mountPointOf(entry: PlistObject): string | undefined {
  const entities = (entry['system-entities'] ?? []) as PlistObject[]
  for (const entity of entities) {
    if (typeof entity['mount-point'] === 'string') return entity['mount-point']
  }
  return undefined
}

export function parseAttachOutput(plistXml: string): string | undefined {
  return mountPointOf(plistParse(plistXml) as PlistObject)
}

interface Attachment {
  mountPoint: string
  detach: () => Promise<void>
}

async function existingMount(image: string): Promise<string | undefined> {
  const info = plistParse(
    await run('/usr/bin/hdiutil', ['info', '-plist'])
  ) as PlistObject
  const images = (info.images ?? []) as PlistObject[]
  const wanted = resolve(image)
  for (const entry of images) {
    if (entry['image-path'] !== wanted) continue
    const mountPoint = mountPointOf(entry)
    if (mountPoint) return mountPoint
  }
  return undefined
}

async function attach(image: string): Promise<Attachment> {
  const mounted = await existingMount(image)
  if (mounted) return { mountPoint: mounted, detach: async () => undefined }

  // The "Y" accepts the image's license agreement, which the user confirmed in Heroic
  const output = await run(
    '/usr/bin/hdiutil',
    [
      'attach',
      '-nobrowse',
      '-readonly',
      '-noautoopen',
      '-mountrandom',
      '/tmp',
      '-plist',
      image
    ],
    'Y\n'
  )
  const mountPoint = parseAttachOutput(output)
  if (!mountPoint) throw new Error(`${basename(image)} has no volume to mount`)
  return {
    mountPoint,
    detach: async () =>
      run('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet']).then(
        () => undefined,
        () => undefined
      )
  }
}

/**
 * Finds Apple's `redist/lib` folder in a mounted image. Apple's download wraps
 * it in a second image ("Evaluation environment for Windows games"), which
 * gets mounted too
 */
async function findRedist(
  mountPoint: string,
  attachments: Attachment[],
  depth = 1
): Promise<string | undefined> {
  const redist = join(mountPoint, 'redist', 'lib')
  if (existsSync(join(redist, FRAMEWORK))) return redist
  if (depth === 0) return undefined

  for (const entry of readdirSync(mountPoint)) {
    if (!entry.toLowerCase().endsWith('.dmg')) continue
    const inner = await attach(join(mountPoint, entry))
    attachments.push(inner)
    const found = await findRedist(inner.mountPoint, attachments, depth - 1)
    if (found) return found
  }
  return undefined
}

/**
 * The newest installed toolkit (Gcenx's Game Porting Toolkit builds) that
 * wasn't itself imported: its Wine is what Apple's redistributable plugs into
 */
export function findBaseToolkit(toolkitDir: string): string | undefined {
  if (!existsSync(toolkitDir)) return undefined
  return readdirSync(toolkitDir)
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(toolkitDir, name))
    .filter(
      (path) =>
        existsSync(join(path, WINE_BIN)) &&
        existsSync(join(path, WINE_LIB, FRAMEWORK)) &&
        !existsSync(join(path, MARKER))
    )
    .sort((a, b) =>
      basename(b).localeCompare(basename(a), undefined, { numeric: true })
    )[0]
}

/**
 * Deletes what a D3DMetal release put into a Wine `lib` folder: `external`,
 * the unix libraries (symlinks into `external`) and the PE builtins sharing
 * their names, including the copies Heroic's MetalFX setup made
 */
export async function removeD3DMetal(lib: string): Promise<void> {
  const unixDir = join(lib, 'wine', 'x86_64-unix')
  const windowsDir = join(lib, 'wine', 'x86_64-windows')
  const names = new Set<string>()

  for (const entry of await readdir(unixDir)) {
    const path = join(unixDir, entry)
    if (!(await lstat(path)).isSymbolicLink()) continue
    if (!(await readlink(path)).split('/').includes('external')) continue
    names.add(entry.replace(/\.so$/, ''))
    await rm(path)
  }
  for (const entry of await readdir(windowsDir)) {
    const match = entry.match(/^(.+?)\.dll(\..+)?$/)
    if (match && names.has(match[1])) await rm(join(windowsDir, entry))
  }
  await rm(join(lib, 'external'), { recursive: true, force: true })
}

async function copyTree(source: string, target: string) {
  try {
    // clonefile(2): instant and takes no extra space on APFS
    await run('/bin/cp', ['-c', '-R', '-p', source, target])
  } catch {
    await rm(target, { recursive: true, force: true })
    await run('/usr/bin/ditto', [source, target])
  }
}

/**
 * Builds a Game Porting Toolkit runner from the disk image Apple publishes on
 * developer.apple.com/games (for example "Game_Porting_Toolkit_4.0_beta_3.dmg").
 * Following Apple's Read Me, the newest installed toolkit is copied and its
 * D3DMetal replaced with the image's `redist/lib`
 *
 * @param image Apple's image, or the "Evaluation environment" image inside it
 * @param toolkitDir Heroic's `tools/game-porting-toolkit` folder
 */
export async function importGamePortingToolkit(
  image: string,
  toolkitDir: string
): Promise<ImportedToolkit> {
  const base = findBaseToolkit(toolkitDir)
  if (!base) {
    throw new Error(
      'Install Game Porting Toolkit from the Wine Manager first: its Wine is needed to run the D3DMetal from the image'
    )
  }

  const attachments: Attachment[] = []
  try {
    const outer = await attach(image)
    attachments.push(outer)
    const redist = await findRedist(outer.mountPoint, attachments)
    if (!redist) {
      throw new Error(
        `${basename(image)} doesn't contain Apple's evaluation environment (redist/lib/external/D3DMetal.framework)`
      )
    }

    const version = await readBundleVersion(join(redist, FRAMEWORK))
    if (parseMajorVersion(version) < MIN_D3DMETAL) {
      throw new Error(
        `The image has D3DMetal ${version || 'of an unknown version'}, Heroic needs ${MIN_D3DMETAL} or newer`
      )
    }

    const name = `Game-Porting-Toolkit-D3DMetal-${version}`
    const staging = join(toolkitDir, STAGING)
    const partial = join(staging, name)
    await rm(partial, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    await copyTree(base, partial)

    const lib = join(partial, WINE_LIB)
    await removeD3DMetal(lib)
    await run('/usr/bin/ditto', ['--noqtn', redist, lib])

    const copied = await readBundleVersion(join(lib, FRAMEWORK))
    if (copied !== version) {
      throw new Error(
        `Copying D3DMetal ${version} failed, the runner has ${copied || 'none'}`
      )
    }

    const marker: ToolkitMarker = {
      d3dmetal: version,
      base: basename(base),
      source: basename(image),
      imported: new Date().toISOString()
    }
    await writeFile(join(partial, MARKER), JSON.stringify(marker, null, 2))

    const target = join(toolkitDir, name)
    await rm(target, { recursive: true, force: true })
    await rename(partial, target)
    await rm(staging, { recursive: true, force: true })

    return {
      name,
      path: target,
      d3dmetalVersion: version,
      base: basename(base)
    }
  } finally {
    for (const attachment of attachments.reverse()) await attachment.detach()
  }
}
