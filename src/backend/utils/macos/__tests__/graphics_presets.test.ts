import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findProperty, parseGvas, structFields, mapEntry } from '../gvas'
import {
  GRAPHICS_PRESET_PROFILES,
  syncGraphicsPreset,
  upgradeGraphicsSave
} from '../graphics_presets'
import {
  hellblade2LowGraphics,
  hellblade2SystemSettings,
  nameProp,
  save
} from './gvas_fixtures'

const hellblade = GRAPHICS_PRESET_PROFILES[0]

function nameValue(
  properties: ReturnType<typeof parseGvas>['properties'] | undefined,
  name: string
) {
  const value = findProperty(properties ?? [], name)?.value
  return value?.kind === 'string' ? value.value : undefined
}

function readGraphics(data: Buffer) {
  const { properties } = parseGvas(data)
  const preset = structFields(
    findProperty(properties, 'GlobalQualityPreset')?.value
  )
  const dlss = structFields(
    mapEntry(findProperty(properties, 'UpscalerSettings'), 'DLSS')
  )
  const dynamicResolution = findProperty(
    properties,
    'IsDynamicResolution'
  )?.value
  return {
    preset: Object.fromEntries(
      (preset ?? []).map((field) => [field.name, nameValue(preset, field.name)])
    ),
    upscaler: nameValue(properties, 'UpscalerId'),
    dlssMode: nameValue(dlss, 'QualityModeId'),
    dynamicResolution:
      dynamicResolution?.kind === 'bool' ? dynamicResolution.value : undefined
  }
}

describe('Highest graphics settings', () => {
  test('raises every quality setting and selects DLSS Quality', () => {
    const result = upgradeGraphicsSave(hellblade2LowGraphics(), hellblade, {
      dlss: true
    })

    expect(result?.changes).toHaveLength(3)
    const graphics = readGraphics(result!.data)
    expect(Object.values(graphics.preset)).toEqual(Array(10).fill('High'))
    expect(graphics.dynamicResolution).toBe(false)
    expect(graphics.upscaler).toBe('DLSS')
    expect(graphics.dlssMode).toBe('Quality')
    // Properties are kept in the order the game writes them
    expect(parseGvas(result!.data).properties.map(({ name }) => name)).toEqual([
      'Gamma',
      'IsVSyncEnabled',
      'IsDynamicResolution',
      'GlobalQualityPreset',
      'UpscalerId',
      'ReflexId',
      'UpscalerSettings',
      'DataVersion'
    ])
  })

  test('leaves the upscaler alone without DLSS', () => {
    for (const [data, dlss] of [
      [hellblade2LowGraphics(), false],
      [hellblade2LowGraphics({ dlss: false }), true]
    ] as const) {
      const graphics = readGraphics(
        upgradeGraphicsSave(data, hellblade, { dlss })!.data
      )
      expect(graphics.upscaler).toBeUndefined()
      expect(Object.values(graphics.preset)).toEqual(Array(10).fill('High'))
    }
  })

  test('changes nothing when the settings are already the highest', () => {
    const raised = upgradeGraphicsSave(hellblade2LowGraphics(), hellblade, {
      dlss: true
    })!.data
    expect(
      upgradeGraphicsSave(raised, hellblade, { dlss: true })
    ).toBeUndefined()
  })

  test('refuses saves of another kind', () => {
    const other = save('/Script/Other.SaveModel', [nameProp('A', 'B')])
    expect(() => upgradeGraphicsSave(other, hellblade, { dlss: true })).toThrow(
      'not /Script/NTUI.NTVMGraphicsSettingsSaveModel'
    )
  })

  describe('before and after launches', () => {
    let root: string
    let prefix: string
    let gameRoot: string
    let saveGames: string
    const graphicsSave = () => join(saveGames, 'GraphicsSettings.Windows.sav')
    const systemSave = () => join(saveGames, 'SystemSettings.Windows.sav')
    const sync = async (enabled = true) =>
      syncGraphicsPreset(prefix, [gameRoot], enabled, { dlss: true })
    const writeGameSaves = (firstLaunchDone: boolean) => {
      writeFileSync(graphicsSave(), hellblade2LowGraphics())
      writeFileSync(systemSave(), hellblade2SystemSettings(firstLaunchDone))
    }

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'heroic-graphics-'))
      prefix = join(root, 'prefix')
      gameRoot = join(root, 'game')
      saveGames = join(
        prefix,
        'drive_c/users/crossover/AppData/Local/Hellblade2/Saved/SaveGames'
      )
      mkdirSync(saveGames, { recursive: true })
      mkdirSync(join(gameRoot, 'Hellblade2/Binaries/Win64'), {
        recursive: true
      })
      writeFileSync(join(gameRoot, hellblade.shippingBinary), '')
    })

    afterEach(() => rmSync(root, { recursive: true, force: true }))

    test('ignores games without a profile', async () => {
      rmSync(join(gameRoot, hellblade.shippingBinary))
      writeGameSaves(true)
      expect(await sync()).toEqual({ status: 'unchanged' })
      expect(readFileSync(graphicsSave())).toEqual(hellblade2LowGraphics())
    })

    test('waits until the game finished its first launch', async () => {
      expect((await sync()).status).toBe('waiting-for-first-launch')

      // The game saved its settings, but hasn't finished the first launch
      writeGameSaves(false)
      expect((await sync()).status).toBe('waiting-for-first-launch')
      expect(readFileSync(graphicsSave())).toEqual(hellblade2LowGraphics())
    })

    test('raises the settings once and keeps later changes', async () => {
      writeGameSaves(true)

      const result = await sync()
      expect(result.status).toBe('raised')
      expect(
        readGraphics(readFileSync(graphicsSave())).preset.ShadowQuality
      ).toBe('High')
      expect(existsSync(join(prefix, '.heroic-graphics.json'))).toBe(true)

      // The player lowers the settings in the game
      writeFileSync(graphicsSave(), hellblade2LowGraphics())
      expect(await sync()).toEqual({ status: 'unchanged' })
      expect(readFileSync(graphicsSave())).toEqual(hellblade2LowGraphics())
    })

    test('raises the settings again after the game started over', async () => {
      writeGameSaves(true)
      await sync()

      // The saves were deleted, so the game runs its first launch again
      rmSync(graphicsSave())
      rmSync(systemSave())
      expect((await sync()).status).toBe('waiting-for-first-launch')
      writeGameSaves(true)
      expect((await sync()).status).toBe('raised')
    })

    test('raises the settings again when the setting is turned back on', async () => {
      writeGameSaves(true)
      await sync()

      expect(await sync(false)).toEqual({ status: 'unchanged' })
      expect(existsSync(join(prefix, '.heroic-graphics.json'))).toBe(false)
      writeFileSync(graphicsSave(), hellblade2LowGraphics())
      expect((await sync()).status).toBe('raised')
    })
  })
})
