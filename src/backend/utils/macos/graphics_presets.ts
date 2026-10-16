import { existsSync } from 'graceful-fs'
import { readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  boolProperty,
  findProperty,
  mapEntry,
  nameProperty,
  parseGvas,
  serializeGvas,
  structFields,
  type GvasProperty
} from './gvas'
import { findUserDirectory } from './unreal'

export interface GraphicsUpgradeOptions {
  /** DLSS runs on MetalFX, so it can be selected as the game's upscaler */
  dlss: boolean
}

export interface GraphicsPresetProfile {
  id: string
  title: string
  /** Folder name below `AppData/Local` the game saves its settings in */
  project: string
  /** Path of the game's shipping binary relative to its install folder, used to identify the game */
  shippingBinary: string
  /** Name of the graphics settings save in `Saved/SaveGames`, without the platform and extension */
  saveName: string
  saveClass: string
  /** The save and boolean property recording that the game finished its first launch */
  firstLaunch: { saveName: string; property: string }
  /**
   * Raises the settings in the save's properties to the highest the game offers
   *
   * @returns A description of every change, empty if nothing changed
   */
  upgrade: (
    properties: GvasProperty[],
    options: GraphicsUpgradeOptions
  ) => string[]
}

function insertBefore(
  properties: GvasProperty[],
  property: GvasProperty,
  before: string[]
) {
  const index = properties.findIndex(({ name }) => before.includes(name))
  if (index === -1) properties.push(property)
  else properties.splice(index, 0, property)
}

/** Sets a name property, adding it if missing. Returns the previous value if it changed */
function setName(
  properties: GvasProperty[],
  name: string,
  value: string,
  before: string[] = []
): { changed: boolean; previous?: string } {
  const existing = findProperty(properties, name)
  if (!existing) {
    insertBefore(properties, nameProperty(name, value), before)
    return { changed: true }
  }
  if (existing.value.kind !== 'string' || existing.value.value === value) {
    return { changed: false }
  }
  const previous = existing.value.value
  existing.value = { kind: 'string', value }
  return { changed: true, previous }
}

function setBool(
  properties: GvasProperty[],
  name: string,
  value: boolean,
  before: string[]
): boolean {
  const existing = findProperty(properties, name)
  if (!existing) {
    insertBefore(properties, boolProperty(name, value), before)
    return true
  }
  if (existing.value.kind !== 'bool' || existing.value.value === value) {
    return false
  }
  existing.value = { kind: 'bool', value }
  return true
}

/**
 * The game's highest preset, read from its `NTUI/Data/BaseGraphics` asset.
 * The `Ultra` value of the preset enum has no settings behind it
 */
const HELLBLADE2_HIGHEST_PRESET: Record<string, string> = {
  ShadowQuality: 'High',
  GlobalIlluminationQuality: 'High',
  ReflectionQuality: 'High',
  TextureQuality: 'High',
  PostProcessingQuality: 'High',
  FoliageDetail: 'High',
  ViewDistance: 'High',
  VolumetricFog: 'High',
  AntiAliasingQuality: 'High',
  EffectsQuality: 'High'
}

/** Properties of `NTVMGraphicsSettingsSaveModel` in the order the game writes them */
const HELLBLADE2_AFTER_DYNAMIC_RESOLUTION = [
  'IsDynamicResolution_DefaultUpscaler',
  'DynamicResolutionMin',
  'DynamicResolutionTargetFramerate',
  'GlobalQualityPreset',
  'UpscalerId',
  'ReflexId',
  'UpscalerSettings',
  'DataVersion'
]
const HELLBLADE2_AFTER_PRESET = HELLBLADE2_AFTER_DYNAMIC_RESOLUTION.slice(4)
const HELLBLADE2_AFTER_UPSCALER = HELLBLADE2_AFTER_PRESET.slice(1)

function upgradeHellblade2(
  properties: GvasProperty[],
  { dlss }: GraphicsUpgradeOptions
): string[] {
  const changes: string[] = []

  let preset = findProperty(properties, 'GlobalQualityPreset')
  if (!preset) {
    preset = {
      name: 'GlobalQualityPreset',
      type: 'StructProperty',
      arrayIndex: 0,
      tag: {
        structName: 'NTGlobalQualityPreset',
        structGuid: Buffer.alloc(16)
      },
      value: { kind: 'properties', properties: [] }
    }
    insertBefore(properties, preset, HELLBLADE2_AFTER_PRESET)
  }
  const presetFields = structFields(preset.value)
  if (presetFields) {
    const raised = Object.entries(HELLBLADE2_HIGHEST_PRESET).filter(
      ([setting, value]) => setName(presetFields, setting, value).changed
    )
    if (raised.length) {
      changes.push(
        `graphics quality: every setting at its highest level, High (raised ${raised.map(([setting]) => setting).join(', ')})`
      )
    }
  }

  // Lowers the resolution whenever the frame rate drops below its target,
  // which blurs the image
  if (
    setBool(
      properties,
      'IsDynamicResolution',
      false,
      HELLBLADE2_AFTER_DYNAMIC_RESOLUTION
    )
  ) {
    changes.push(
      'dynamic resolution: off, the game renders at a fixed resolution'
    )
  }

  // The game only lists DLSS when it found a working DLSS runtime
  const dlssSettings = structFields(
    mapEntry(findProperty(properties, 'UpscalerSettings'), 'DLSS')
  )
  if (dlss && dlssSettings) {
    const upscaler = setName(
      properties,
      'UpscalerId',
      'DLSS',
      HELLBLADE2_AFTER_UPSCALER
    )
    const mode = setName(dlssSettings, 'QualityModeId', 'Quality')
    if (upscaler.changed || mode.changed) {
      changes.push('upscaler: DLSS (on MetalFX) in Quality mode')
    }
  }
  return changes
}

export const GRAPHICS_PRESET_PROFILES: GraphicsPresetProfile[] = [
  {
    id: 'hellblade2',
    title: "Senua's Saga: Hellblade II",
    project: 'Hellblade2',
    shippingBinary: 'Hellblade2/Binaries/Win64/Hellblade2-Win64-Shipping.exe',
    saveName: 'GraphicsSettings',
    saveClass: '/Script/NTUI.NTVMGraphicsSettingsSaveModel',
    firstLaunch: { saveName: 'SystemSettings', property: 'bFirstLaunch' },
    upgrade: upgradeHellblade2
  }
]

export function findGraphicsPresetProfile(
  gameRoots: string[]
): GraphicsPresetProfile | undefined {
  return GRAPHICS_PRESET_PROFILES.find((profile) =>
    gameRoots.some((root) => existsSync(join(root, profile.shippingBinary)))
  )
}

/**
 * Upgrades the settings in a graphics save
 *
 * @returns The new file contents and the changes, or nothing if no change was needed
 */
export function upgradeGraphicsSave(
  data: Buffer,
  profile: GraphicsPresetProfile,
  options: GraphicsUpgradeOptions
): { data: Buffer; changes: string[] } | undefined {
  const save = parseGvas(data)
  if (save.saveClass !== profile.saveClass) {
    throw new Error(
      `The ${profile.saveName} save holds a ${save.saveClass}, not ${profile.saveClass}`
    )
  }
  const changes = profile.upgrade(save.properties, options)
  if (!changes.length) return
  return { data: serializeGvas(save), changes }
}

/** Records, per profile, that Heroic raised the settings the game picked on its first launch */
const PREFIX_MANIFEST = '.heroic-graphics.json'

type PrefixManifest = Record<string, { raised: string }>

async function readManifest(prefix: string): Promise<PrefixManifest> {
  try {
    return JSON.parse(
      await readFile(join(prefix, PREFIX_MANIFEST), 'utf-8')
    ) as PrefixManifest
  } catch {
    return {}
  }
}

async function writeManifest(prefix: string, manifest: PrefixManifest) {
  const path = join(prefix, PREFIX_MANIFEST)
  if (Object.keys(manifest).length) {
    await writeFile(path, JSON.stringify(manifest, null, 2))
  } else {
    await rm(path, { force: true })
  }
}

// Steam/GOG/Epic builds use `Windows`, Microsoft Store/Game Pass builds `WinGDK`
const SAVE_PLATFORMS = ['Windows', 'WinGDK']

function findSave(saved: string, name: string): string | undefined {
  return SAVE_PLATFORMS.map((platform) =>
    join(saved, 'SaveGames', `${name}.${platform}.sav`)
  ).find((path) => existsSync(path))
}

/**
 * Whether the game finished its first launch. Until then it replaces the
 * graphics settings with the ones it picks from a hardware benchmark
 */
async function finishedFirstLaunch(
  saved: string,
  profile: GraphicsPresetProfile
): Promise<boolean> {
  const path = findSave(saved, profile.firstLaunch.saveName)
  if (!path) return false
  const property = findProperty(
    parseGvas(await readFile(path)).properties,
    profile.firstLaunch.property
  )
  // Unreal leaves out properties that still have their default value (`true`)
  return property?.value.kind === 'bool' && !property.value.value
}

export type GraphicsPresetResult =
  | { status: 'raised'; message: string }
  | { status: 'waiting-for-first-launch'; message: string }
  | { status: 'unchanged' }

/**
 * Raises the graphics settings of a supported game to the highest it offers,
 * once after the game picked its own settings on its first launch. Changes
 * the player makes in the game afterwards are kept. Meant to run both before
 * the game starts and after it exits, since the game only writes its settings
 * during its first launch
 */
export async function syncGraphicsPreset(
  prefix: string,
  gameRoots: string[],
  enabled: boolean,
  options: GraphicsUpgradeOptions
): Promise<GraphicsPresetResult> {
  const profile = findGraphicsPresetProfile(gameRoots)
  if (!profile) return { status: 'unchanged' }

  const manifest = await readManifest(prefix)
  const forget = async () => {
    if (!manifest[profile.id]) return
    delete manifest[profile.id]
    await writeManifest(prefix, manifest)
  }
  if (!enabled) {
    // Turning the setting back on raises the settings again
    await forget()
    return { status: 'unchanged' }
  }

  const userDir = findUserDirectory(prefix, profile.project)
  const saved =
    userDir && join(userDir, 'AppData', 'Local', profile.project, 'Saved')
  const savePath = saved && findSave(saved, profile.saveName)
  if (!saved || !savePath || !(await finishedFirstLaunch(saved, profile))) {
    await forget()
    return {
      status: 'waiting-for-first-launch',
      message: `${profile.title} picks its own graphics settings on its first launch. Heroic raises them to the highest once the game has saved them, after it exits`
    }
  }
  if (manifest[profile.id]) return { status: 'unchanged' }

  const result = upgradeGraphicsSave(await readFile(savePath), profile, options)
  if (result) await writeFile(savePath, result.data)
  manifest[profile.id] = { raised: new Date().toISOString() }
  await writeManifest(prefix, manifest)
  if (!result) return { status: 'unchanged' }
  return {
    status: 'raised',
    message: `Raised ${profile.title}'s graphics settings in ${savePath}: ${result.changes.join('; ')}. Changes made in the game from now on are kept`
  }
}
