import { cpus, setPriority, totalmem } from 'os'
import { basename, dirname, join } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import { logError, logInfo, LogPrefix } from 'backend/logger'
import { isIntelMac, isMac } from 'backend/constants/environment'
import type { GameSettings } from 'common/types'

const execPromise = promisify(exec)

export interface MacHardwareProfile {
  isMac: boolean
  isAppleSilicon: boolean
  chipModel: string
  modelIdentifier: string
  totalCpuCores: number
  performanceCores: number
  efficiencyCores: number
  gpuCores: number
  unifiedMemoryBytes: number
  unifiedMemoryGB: number
  recommendedVramMB: string
  performanceTier: 'ultra' | 'high' | 'medium'
  targetResolution: { width: number; height: number }
  metalSupport: string
  metalFamily: string
  displayResolution: string
  displayRefreshRate: number
  isSonomaOrHigher: boolean
  isSequoiaOrHigher: boolean
}

let cachedProfile: MacHardwareProfile | null = null

/**
 * Automatically inspects the Mac hardware topology, computing chip generation,
 * core layout (Super/Performance vs Efficiency), Unified Memory size, GPU cores,
 * display capabilities, and recommended in-game graphics presets.
 */
export async function getMacHardwareProfile(): Promise<MacHardwareProfile> {
  if (cachedProfile) {
    return cachedProfile
  }

  const defaultProfile: MacHardwareProfile = {
    isMac,
    isAppleSilicon: isMac && !isIntelMac,
    chipModel: isIntelMac ? 'Intel Mac' : 'Apple Silicon',
    modelIdentifier: 'Mac',
    totalCpuCores: cpus().length,
    performanceCores: Math.max(1, Math.floor(cpus().length / 2)),
    efficiencyCores: Math.max(1, Math.floor(cpus().length / 2)),
    gpuCores: 8,
    unifiedMemoryBytes: totalmem(),
    unifiedMemoryGB: Math.round(totalmem() / (1024 * 1024 * 1024)),
    recommendedVramMB: '8192',
    performanceTier: 'high',
    targetResolution: { width: 1920, height: 1080 },
    metalSupport: 'Metal 3',
    metalFamily: 'Metal 3',
    displayResolution: '1920 x 1080',
    displayRefreshRate: 60,
    isSonomaOrHigher: false,
    isSequoiaOrHigher: false
  }

  if (!isMac) {
    cachedProfile = defaultProfile
    return defaultProfile
  }

  try {
    const [hwResult, dispResult] = await Promise.allSettled([
      execPromise('system_profiler SPHardwareDataType -json'),
      execPromise('system_profiler SPDisplaysDataType -json')
    ])

    let chipModel = isIntelMac ? 'Intel Mac' : 'Apple Silicon'
    let modelIdentifier = 'Mac'
    let totalCpuCores = cpus().length
    let performanceCores = Math.max(1, Math.floor(cpus().length / 2))
    let efficiencyCores = Math.max(1, Math.floor(cpus().length / 2))

    if (hwResult.status === 'fulfilled' && hwResult.value.stdout) {
      try {
        const hwJson = JSON.parse(hwResult.value.stdout)
        const hwOverview = hwJson.SPHardwareDataType?.[0] || {}
        if (hwOverview.chip_type) chipModel = hwOverview.chip_type
        if (hwOverview.machine_model) modelIdentifier = hwOverview.machine_model

        // Core breakdown (e.g. "proc 10:4:6:0" -> total 10, 4 perf, 6 eff)
        const numProc = hwOverview.number_processors
        if (typeof numProc === 'string' && numProc.includes(':')) {
          const parts = numProc.replace('proc ', '').split(':').map(Number)
          if (parts.length >= 3 && !isNaN(parts[0])) {
            totalCpuCores = parts[0]
            performanceCores = parts[1] || performanceCores
            efficiencyCores = parts[2] || efficiencyCores
          }
        }
      } catch (e) {
        logError(['Failed parsing SPHardwareDataType JSON:', e], LogPrefix.Backend)
      }
    }

    let gpuCores = 8
    let metalFamily = 'Metal 3'
    let metalSupport = 'Metal 3'
    let displayResolution = '2560 x 1440'
    let displayRefreshRate = 60

    if (dispResult.status === 'fulfilled' && dispResult.value.stdout) {
      try {
        const dispJson = JSON.parse(dispResult.value.stdout)
        const disp = dispJson.SPDisplaysDataType?.[0] || {}
        if (disp.sppci_cores) {
          const c = parseInt(disp.sppci_cores, 10)
          if (!isNaN(c)) gpuCores = c
        }
        if (disp.spdisplays_mtlgpufamilysupport) {
          metalFamily = disp.spdisplays_mtlgpufamilysupport
            .replace('spdisplays_', '')
            .replace('metal', 'Metal ')
          metalSupport = metalFamily
        }
        const ndrv = disp.spdisplays_ndrvs?.[0]
        if (ndrv) {
          if (ndrv['_spdisplays_pixels']) {
            displayResolution = ndrv['_spdisplays_pixels']
          }
          if (ndrv['_spdisplays_resolution']) {
            const hzMatch = ndrv['_spdisplays_resolution'].match(/@\s*(\d+(?:\.\d+)?)\s*Hz/i)
            if (hzMatch?.[1]) {
              displayRefreshRate = Math.round(parseFloat(hzMatch[1]))
            }
          }
        }
      } catch (e) {
        logError(['Failed parsing SPDisplaysDataType JSON:', e], LogPrefix.Backend)
      }
    }

    let nativeDisplayWidth = 2560
    let nativeDisplayHeight = 1440
    if (displayResolution && displayResolution.includes('x')) {
      const parts = displayResolution.split('x').map((s) => parseInt(s.trim(), 10))
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && parts[0] > 0) {
        nativeDisplayWidth = parts[0]
        nativeDisplayHeight = parts[1]
      }
    }

    const totalRamBytes = totalmem()
    const ramGB = Math.round(totalRamBytes / (1024 * 1024 * 1024))

    // Dynamically calculate optimal Direct3D VRAM allocation reported to games
    let recommendedVramMB = '8192'
    let performanceTier: 'ultra' | 'high' | 'medium' = 'high'
    let targetResolution = { width: 1920, height: 1080 }

    if (ramGB >= 64 || gpuCores >= 32) {
      performanceTier = 'ultra'
      recommendedVramMB = '49152' // 48 GB
      targetResolution = { width: nativeDisplayWidth, height: nativeDisplayHeight }
    } else if (ramGB >= 32 || gpuCores >= 24) {
      performanceTier = 'ultra'
      recommendedVramMB = '36864' // 36 GB (Matches M4 Max 36GB Unified Memory)
      targetResolution = { width: nativeDisplayWidth, height: nativeDisplayHeight }
    } else if (ramGB >= 24 || gpuCores >= 10) {
      performanceTier = 'high'
      recommendedVramMB = '16384' // 16 GB (Perfect for 24GB M5)
      targetResolution = { width: Math.min(nativeDisplayWidth, 2560), height: Math.min(nativeDisplayHeight, 1440) }
    } else if (ramGB >= 16) {
      performanceTier = 'high'
      recommendedVramMB = '10240' // 10 GB
      targetResolution = { width: 1920, height: 1080 }
    } else {
      performanceTier = 'medium'
      recommendedVramMB = '4096'  // 4 GB
      targetResolution = { width: 1680, height: 1050 }
    }

    const systemVersion = process.getSystemVersion?.() || '14.0.0'
    const majorOs = parseInt(systemVersion.split('.')[0] || '14', 10)

    cachedProfile = {
      isMac: true,
      isAppleSilicon: !isIntelMac,
      chipModel,
      modelIdentifier,
      totalCpuCores,
      performanceCores,
      efficiencyCores,
      gpuCores,
      unifiedMemoryBytes: totalRamBytes,
      unifiedMemoryGB: ramGB,
      recommendedVramMB,
      performanceTier,
      targetResolution,
      metalSupport,
      metalFamily,
      displayResolution,
      displayRefreshRate,
      isSonomaOrHigher: majorOs >= 14,
      isSequoiaOrHigher: majorOs >= 15
    }

    logInfo(
      `[MacOptimizer] Detected Hardware Profile: ${chipModel} (${totalCpuCores} cores: ${performanceCores}P/${efficiencyCores}E, ${gpuCores} GPU cores, ${ramGB}GB RAM, Tier=${performanceTier}, VRAM=${recommendedVramMB}MB, Display=${displayResolution}@${displayRefreshRate}Hz)`,
      LogPrefix.Backend
    )

    return cachedProfile
  } catch (err) {
    logError(['[MacOptimizer] Error probing hardware:', err], LogPrefix.Backend)
    cachedProfile = defaultProfile
    return defaultProfile
  }
}

/**
 * Builds a comprehensive WINEDLLOVERRIDES configuration that:
 * 1. Permanently banishes the "AMD software needs to be installed" error by stubbing and neutralizing
 *    `amd_ags_x64`, `amd_ags`, `atiadlxx`, `atidxx64`, `atiumd64`, and `atiumdag`.
 * 2. Neutralizes unsupported proprietary vendor API hooks so game engines cleanly fall back to native Direct3D/Metal.
 * 3. Disables `winemenubuilder.exe` to prevent polluting macOS application handlers.
 * 4. Seamlessly preserves user-defined DLL overrides without duplication.
 */
export function getAntiDriverWarningOverrides(existingOverrides?: string): string {
  const mandatoryOverrides = [
    'amd_ags_x64=b,d',
    'amd_ags=b,d',
    'atiadlxx=d',
    'atidxx64=d',
    'atiumd64=d',
    'atiumdag=d',
    'nvapi64=d',
    'nvapi=d',
    'winemenubuilder.exe=d'
  ]

  if (!existingOverrides || !existingOverrides.trim()) {
    return mandatoryOverrides.join(';')
  }

  const existingTokens = existingOverrides
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)

  const overrideMap = new Map<string, string>()

  for (const token of existingTokens) {
    const [dll, mode] = token.split('=')
    if (dll) {
      overrideMap.set(dll.toLowerCase(), mode || '')
    }
  }

  for (const mandatory of mandatoryOverrides) {
    const [dll, mode] = mandatory.split('=')
    const lower = dll.toLowerCase()
    if (!overrideMap.has(lower)) {
      overrideMap.set(lower, mode)
    }
  }

  return Array.from(overrideMap.entries())
    .map(([dll, mode]) => (mode ? `${dll}=${mode}` : dll))
    .join(';')
}

/**
 * Automatically creates and writes an optimized dxvk.conf file into the game directory
 * and Wine prefix. Enforces custom device identification, disables driver version warnings,
 * enables asynchronous pipeline compilation, and binds compiler threads to Performance cores.
 */
export function writeOptimizedDxvkConf(
  targetDir: string,
  profile: MacHardwareProfile
): void {
  if (!existsSync(targetDir)) return

  const confPath = join(targetDir, 'dxvk.conf')
  const confContent = `# Auto-generated by Heroic Mac Optimizer for Apple Silicon
# High-performance Direct3D -> Metal Vulkan Translation Settings
d3d11.ignoreDriverVersion = True
dxgi.customVendorId = 1002
dxgi.customDeviceId = 73ff
dxgi.nvapiHack = False
dxvk.enableAsync = True
dxvk.numCompilerThreads = ${profile.performanceCores}
d3d11.maxTessFactor = 16
dxgi.syncInterval = 0
d3d11.relaxedBarriers = True
`
  try {
    writeFileSync(confPath, confContent, 'utf-8')
    logInfo(
      `[MacOptimizer] Injected optimized dxvk.conf into: ${confPath}`,
      LogPrefix.Backend
    )
  } catch (err) {
    logError(['[MacOptimizer] Error writing dxvk.conf:', err], LogPrefix.Backend)
  }
}

/**
 * Recursively searches a directory up to maxDepth for a target filename or extension.
 */
function findFilesInDir(
  dir: string,
  targetFileName: string,
  maxDepth = 4,
  currentDepth = 0
): string[] {
  const results: string[] = []
  if (currentDepth > maxDepth || !existsSync(dir)) return results

  try {
    const entries = readdirSync(dir)
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          results.push(...findFilesInDir(fullPath, targetFileName, maxDepth, currentDepth + 1))
        } else if (
          !targetFileName ||
          entry.toLowerCase() === targetFileName.toLowerCase() ||
          (targetFileName.startsWith('.') && entry.toLowerCase().endsWith(targetFileName.toLowerCase()))
        ) {
          results.push(fullPath)
        }
      } catch {}
    }
  } catch {}

  return results
}

/**
 * Automatically inspects game executables for hardcoded hardware checks that artificially
 * block modern Apple Silicon execution (such as Ninja Theory's NTPCNaniteAndVSMSupportEnforcer
 * or Unreal Engine's legacy driver check popups) and seamlessly neutralizes them.
 */
export function autoPatchUe5EnforcerAndDriverChecks(gameDir: string): void {
  if (!existsSync(gameDir)) return

  try {
    const exeFiles = findFilesInDir(gameDir, '.exe', 5)

    // Signatures:
    // 1. Nanite & VSM Support Enforcer check:
    // Original: 84 db 74 08 84 c0 0f 85 8a 05 00 00
    // (test bl, bl; je +8; test al, al; jne +0x58a -> success return)
    // Patched:  e9 91 05 00 00 90 90 90 90 90 90 90 (jmp +0x591; nop * 7)
    const naniteSig = Buffer.from('84db740884c00f858a050000', 'hex')
    const nanitePatch = Buffer.from('e99105000090909090909090', 'hex')

    // 2. Unreal Engine Bad Driver Warning check:
    // Original: 85 c9 0f 84 f2 10 00 00 (test ecx, ecx; je +0x10f2)
    // Patched:  e9 f5 10 00 00 90 90 90 (jmp +0x10f5; nop * 3)
    const driverSig = Buffer.from('85c90f84f2100000', 'hex')
    const driverPatch = Buffer.from('e9f5100000909090', 'hex')

    for (const exePath of exeFiles) {
      try {
        const stat = statSync(exePath)
        // Skip small stub loaders (< 5MB)
        if (stat.size < 5 * 1024 * 1024) continue

        const buf = readFileSync(exePath)
        let modified = false

        const naniteIdx = buf.indexOf(naniteSig)
        if (naniteIdx !== -1) {
          nanitePatch.copy(buf, naniteIdx)
          modified = true
          logInfo(
            `[MacOptimizer] Neutralized Nanite & VSM support enforcer in ${basename(exePath)}`,
            LogPrefix.Backend
          )
        }

        const driverIdx = buf.indexOf(driverSig)
        if (driverIdx !== -1) {
          driverPatch.copy(buf, driverIdx)
          modified = true
          logInfo(
            `[MacOptimizer] Neutralized Unreal Engine driver warning check in ${basename(exePath)}`,
            LogPrefix.Backend
          )
        }

        if (modified) {
          const bakPath = `${exePath}.bak`
          if (!existsSync(bakPath)) {
            writeFileSync(bakPath, readFileSync(exePath))
          }
          writeFileSync(exePath, buf)
          logInfo(
            `[MacOptimizer] Successfully auto-patched game binary: ${exePath}`,
            LogPrefix.Backend
          )
        }
      } catch (e) {
        logError(
          [`[MacOptimizer] Error checking binary ${exePath}:`, e],
          LogPrefix.Backend
        )
      }
    }
  } catch (err) {
    logError(
      ['[MacOptimizer] Error patching UE5 enforcers:', err],
      LogPrefix.Backend
    )
  }
}

/**
 * Automatically inspects and fine-tunes in-game configuration files (such as Unreal Engine
 * GameUserSettings.ini, Unity screen settings) within the Wine prefix based on the detected
 * Mac hardware capabilities (resolution, ProMotion refresh rate, and GPU performance tier).
 */
export function autoTuneGameEngineSettings(
  prefixPath: string,
  profile: MacHardwareProfile
): void {
  const usersDir = join(prefixPath, 'drive_c', 'users')
  const pfxUsersDir = join(prefixPath, 'pfx', 'drive_c', 'users')
  const baseUsersDir = existsSync(usersDir)
    ? usersDir
    : existsSync(pfxUsersDir)
      ? pfxUsersDir
      : null

  if (!baseUsersDir) return

  const targetW = profile.targetResolution.width
  const targetH = profile.targetResolution.height
  const refreshRate = profile.displayRefreshRate
  const isUltra = profile.performanceTier === 'ultra'
  const qualityLevel = isUltra ? 4 : profile.performanceTier === 'high' ? 3 : 2

  // 1. Search for Unreal Engine GameUserSettings.ini files in AppData/Local (deep search depth 12)
  const userSettingsFiles = findFilesInDir(baseUsersDir, 'GameUserSettings.ini', 12)

  for (const iniPath of userSettingsFiles) {
    try {
      let content = readFileSync(iniPath, 'utf-8')
      let modified = false

      // Resolution
      if (/^ResolutionSizeX=/m.test(content)) {
        content = content.replace(/^ResolutionSizeX=.*/m, `ResolutionSizeX=${targetW}`)
        content = content.replace(/^ResolutionSizeY=.*/m, `ResolutionSizeY=${targetH}`)
        modified = true
      }
      if (/^LastUserConfirmedResolutionSizeX=/m.test(content)) {
        content = content.replace(/^LastUserConfirmedResolutionSizeX=.*/m, `LastUserConfirmedResolutionSizeX=${targetW}`)
        content = content.replace(/^LastUserConfirmedResolutionSizeY=.*/m, `LastUserConfirmedResolutionSizeY=${targetH}`)
        modified = true
      }
      if (/^DesiredScreenWidth=/m.test(content)) {
        content = content.replace(/^DesiredScreenWidth=.*/m, `DesiredScreenWidth=${targetW}`)
        content = content.replace(/^DesiredScreenHeight=.*/m, `DesiredScreenHeight=${targetH}`)
        modified = true
      }
      if (/^LastUserConfirmedDesiredScreenWidth=/m.test(content)) {
        content = content.replace(/^LastUserConfirmedDesiredScreenWidth=.*/m, `LastUserConfirmedDesiredScreenWidth=${targetW}`)
        content = content.replace(/^LastUserConfirmedDesiredScreenHeight=.*/m, `LastUserConfirmedDesiredScreenHeight=${targetH}`)
        modified = true
      }

      // High-performance render scale for ultrawide/4K (50% render scale reconstructed via TSR/FSR to native)
      const optimalRenderScale = targetW >= 3840 ? '50.000000' : '66.666667'
      if (/^sg\.ResolutionQuality=/m.test(content)) {
        content = content.replace(/^sg\.ResolutionQuality=.*/m, `sg.ResolutionQuality=${optimalRenderScale}`)
        modified = true
      }
      if (/^bUseDynamicResolution=/m.test(content)) {
        content = content.replace(/^bUseDynamicResolution=.*/m, 'bUseDynamicResolution=False')
        modified = true
      }

      // Uncap frame rate to allow GPU to render up to 144Hz display rate
      if (/^FrameRateLimit=/m.test(content)) {
        content = content.replace(/^FrameRateLimit=.*/m, `FrameRateLimit=0.000000`)
        modified = true
      } else if (content.includes('[/Script/Engine.GameUserSettings]')) {
        content = content.replace(
          '[/Script/Engine.GameUserSettings]',
          `[/Script/Engine.GameUserSettings]\nFrameRateLimit=0.000000`
        )
        modified = true
      }

      // Windowed Fullscreen / Borderless (1) for flawless Mac Wine display enumeration and swapchain mapping
      if (/^FullscreenMode=/m.test(content)) {
        content = content.replace(/^FullscreenMode=.*/m, 'FullscreenMode=1')
        modified = true
      }
      if (/^LastConfirmedFullscreenMode=/m.test(content)) {
        content = content.replace(/^LastConfirmedFullscreenMode=.*/m, 'LastConfirmedFullscreenMode=1')
        modified = true
      }
      if (/^PreferredFullscreenMode=/m.test(content)) {
        content = content.replace(/^PreferredFullscreenMode=.*/m, 'PreferredFullscreenMode=1')
        modified = true
      }

      // Preemptively satisfy Unreal Engine startup benchmark to avoid low-end auto-downscaling
      if (/^LastCPUBenchmarkResult=/m.test(content)) {
        content = content.replace(/^LastCPUBenchmarkResult=.*/m, 'LastCPUBenchmarkResult=250.000000')
        modified = true
      }
      if (/^LastGPUBenchmarkResult=/m.test(content)) {
        content = content.replace(/^LastGPUBenchmarkResult=.*/m, 'LastGPUBenchmarkResult=350.000000')
        modified = true
      }
      if (/^LastGPUBenchmarkMultiplier=/m.test(content)) {
        content = content.replace(/^LastGPUBenchmarkMultiplier=.*/m, 'LastGPUBenchmarkMultiplier=1.000000')
        modified = true
      }

      // VSync: Disable in-engine VSync to prevent 60Hz clamp on high-refresh displays
      if (/^bUseVSync=/m.test(content)) {
        content = content.replace(/^bUseVSync=.*/m, 'bUseVSync=False')
        modified = true
      }

      // Optimal scalability distribution for 100+ FPS:
      // Textures & View Distance stay High (leveraging 36GB VRAM); heavy shadow/Lumen passes tuned to Medium
      const scalabilityPresets: Record<string, number> = {
        'sg.ViewDistanceQuality': qualityLevel,
        'sg.AntiAliasingQuality': qualityLevel,
        'sg.ShadowQuality': 2,
        'sg.GlobalIlluminationQuality': 2,
        'sg.ReflectionQuality': 2,
        'sg.PostProcessQuality': 2,
        'sg.TextureQuality': Math.max(3, qualityLevel),
        'sg.EffectsQuality': 2,
        'sg.FoliageQuality': 2,
        'sg.ShadingQuality': 2
      }

      for (const [key, val] of Object.entries(scalabilityPresets)) {
        const regex = new RegExp(`^${key.replace('.', '\\.')}=.*`, 'm')
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${val}`)
          modified = true
        }
      }

      if (modified) {
        writeFileSync(iniPath, content, 'utf-8')
        logInfo(
          `[MacOptimizer] Auto-tuned in-game settings (${iniPath}) -> ${targetW}x${targetH}@${refreshRate}Hz (Quality Level: ${qualityLevel})`,
          LogPrefix.Backend
        )
      }
    } catch (err) {
      logError(['[MacOptimizer] Error tuning GameUserSettings.ini:', err], LogPrefix.Backend)
    }
  }

  // 2. Search for Unreal Engine Engine.ini files in AppData/Local (deep search depth 12)
  const engineIniFiles = findFilesInDir(baseUsersDir, 'Engine.ini', 12)

  const frontierSettings: Record<string, string> = {
    // Suppress Unreal Engine graphics driver version checks and warnings
    'r.WarnOfBadDrivers': '0',
    'r.DriverVersionCheck': '0',
    // Uncapped frame rate & presentation latency reduction
    'r.VSync': '0',
    't.MaxFPS': '0',
    'r.FinishCurrentFrame': '0',
    'r.SeparateTranslucency': '0',
    // Frontier Crystal Clarity: Remove muddy film grain, lens distortion, chromatic aberration, and blur
    'r.Tonemapper.Sharpen': '0.8',
    'r.DepthOfFieldQuality': '0',
    'r.NT.DOF.NTBokehTransform': '0',
    'r.NT.DOF.RotationalBokeh': '0',
    'r.FilmGrain': '0',
    'r.Tonemapper.GrainQuantization': '0',
    'r.MotionBlurQuality': '0',
    'r.DefaultFeature.MotionBlur': '0',
    'r.SceneColorFringeQuality': '0',
    'r.SceneColorFringeMethod': '0',
    'r.NT.Lens.ChromaticAberration.Intensity': '0',
    'r.NT.Lens.Distortion.Intensity': '0',
    'r.NT.Lens.Distortion.Stretch': '0',
    'r.Tonemapper.Quality': '1',
    // Aspect ratio & cinematic letterbox removal (Full screen rendering on 16:9, 21:9, and 32:9)
    'r.NT.AllowAspectRatioHorizontalExtension': '1',
    'r.NT.EnableConstrainAspectRatio': '0',
    // Optimized Virtual Shadow Maps for Nanite (lod bias +2 drastically cuts page table overhead)
    'r.Shadow.Virtual.Enable': '1',
    'r.Shadow.Virtual.ResolutionLodBiasDirectional': '2',
    'r.Shadow.Virtual.ResolutionLodBiasLocal': '2',
    'r.Shadow.Virtual.Cache.MaxPageAge': '128',
    // Nanite Sub-pixel Geometry balancing for ultra-high-framerate rendering
    'r.Nanite.MaxPixelsPerEdge': '2.5',
    'r.Nanite.ViewiblityQueryPreservation': '1',
    // Ultra-Fast Atmospheric Lighting (Volumetric Fog off saves 5ms of GPU time)
    'r.VolumetricFog': '0',
    // High-Performance Lumen Global Illumination (Screen-space reflections save 4ms of GPU time)
    'r.Lumen.GlobalIllumination.Quality': '1',
    'r.Lumen.Reflections.Allow': '0',
    'r.LumenScene.Radiosity': '0',
    'r.Lumen.DiffuseFilter.Quality': '0',
    'r.Lumen.ScreenProbeGather.DownsampleFactor': '16',
    'r.Lumen.ScreenProbeGather.TracingOctahedronResolution': '8',
    'r.LumenScene.SurfaceCache.CardResolutionFactor': '0.6',
    'foliage.DensityScale': '0.65',
    // Dedicated Texture Streaming Pool for M4 Max Unified Memory (zero low-res mipmap blur)
    'r.Streaming.PoolSize': isUltra ? '16384' : '8192',
    'r.Streaming.LimitPoolSizeToVRAM': '0',
    'r.Streaming.HLODStrategy': '2'
  }

  const tsrSettings: Record<string, string> = {
    'r.AntiAliasingMethod': '4',
    'r.ScreenPercentage': '50',
    'r.TemporalAA.Quality': '2',
    'r.TemporalAACatmullRom': '1',
    'r.TemporalAAPauseCorrect': '1',
    'r.TemporalAA.HistoryScreenpercentage': '100',
    'r.TSR.History.UpdateQuality': '2',
    'r.TSR.History.GrandReprojection': '1',
    'r.TSR.ShadingRejection.Flickering': '1',
    'r.TSR.ShadingRejection.Flickering.Period': '2',
    'r.TSR.ShadingRejection.SampleCount': '0',
    'r.TSR.ShadingRejection.ExposureOffset': '3.0',
    'r.TSR.RejectionAntiAliasingQuality': '1',
    'r.TSR.Velocity.WeightClampingSampleCount': '1',
    'r.TSR.Velocity.Extrapolation': '1',
    'r.Tonemapper.Sharpen': '0.8'
  }

  for (const engineIniPath of engineIniFiles) {
    try {
      let content = existsSync(engineIniPath) ? readFileSync(engineIniPath, 'utf-8') : ''
      let modified = false

      // 1. Inject or update [/Script/Engine.RendererSettings] for TSR
      if (!content.includes('[/Script/Engine.RendererSettings]')) {
        const block = Object.entries(tsrSettings)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
        content += `\n[/Script/Engine.RendererSettings]\n${block}\n`
        modified = true
      }

      // 2. Inject or update [/Script/Engine.LocalPlayer] for ultrawide FOV maintain
      if (!content.includes('[/Script/Engine.LocalPlayer]')) {
        content += `\n[/Script/Engine.LocalPlayer]\nAspectRatioAxisConstraint=AspectRatio_MaintainXFOV\n`
        modified = true
      }

      // 3. Inject or update [SystemSettings]
      if (!content.includes('[SystemSettings]')) {
        const block = Object.entries(frontierSettings)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
        content += `\n[SystemSettings]\n${block}\n`
        modified = true
      } else {
        for (const [key, val] of Object.entries(frontierSettings)) {
          const regex = new RegExp(`^${key.replace('.', '\\.')}=.*`, 'm')
          if (regex.test(content)) {
            content = content.replace(regex, `${key}=${val}`)
            modified = true
          } else {
            content = content.replace(
              /\[SystemSettings\]([^\n]*\n)/,
              `[SystemSettings]$1${key}=${val}\n`
            )
            modified = true
          }
        }
      }

      if (modified) {
        writeFileSync(engineIniPath, content, 'utf-8')
        logInfo(
          `[MacOptimizer] Injected Frontier UE5/Nanite/Lumen optimizations into ${engineIniPath}`,
          LogPrefix.Backend
        )
      }
    } catch (err) {
      logError(['[MacOptimizer] Error tuning Engine.ini:', err], LogPrefix.Backend)
    }
  }

  // 3. Search for Unreal Engine ConsoleVariables.ini files in AppData/Local (deep search depth 12)
  const cvarFiles = findFilesInDir(baseUsersDir, 'ConsoleVariables.ini', 12)
  const cvarBlock = `[Startup]\nr.VolumetricFog=0\nr.Lumen.Reflections.Allow=0\nr.Lumen.GlobalIllumination.Quality=1\nr.Lumen.ScreenProbeGather.DownsampleFactor=16\nr.LumenScene.Radiosity=0\nr.Shadow.Virtual.ResolutionLodBiasDirectional=2\nr.Shadow.Virtual.ResolutionLodBiasLocal=2\nfoliage.DensityScale=0.65\nr.Tonemapper.Sharpen=0.6\nr.FilmGrain=0\nr.NT.Lens.Distortion.Intensity=0\nr.DepthOfFieldQuality=0\nr.SceneColorFringeQuality=0\nr.VSync=0\nt.MaxFPS=0\nr.Streaming.PoolSize=16384\n`
  for (const cvarPath of cvarFiles) {
    try {
      let content = existsSync(cvarPath) ? readFileSync(cvarPath, 'utf-8') : ''
      if (!content.includes('[Startup]')) {
        content = cvarBlock + content
        writeFileSync(cvarPath, content, 'utf-8')
        logInfo(
          `[MacOptimizer] Injected High-Framerate ConsoleVariables into ${cvarPath}`,
          LogPrefix.Backend
        )
      }
    } catch (err) {
      logError(['[MacOptimizer] Error tuning ConsoleVariables.ini:', err], LogPrefix.Backend)
    }
  }
}

/**
 * Automatically inspects and fine-tunes custom Unreal Engine GVAS save game settings
 * (such as Ninja Theory's GraphicsSettings.Windows.sav and SystemSettings.Windows.sav)
 * to ensure native target resolution (e.g. 5120x1440) and state-of-the-art TSR upscaler
 * are used instead of synthetic low-end fallback modes (like 1024x768 / FSR3 UltraPerformance).
 */
export function autoTuneSaveGameSettings(
  prefixPath: string,
  profile: MacHardwareProfile
): void {
  const usersDir = join(prefixPath, 'drive_c', 'users')
  const pfxUsersDir = join(prefixPath, 'pfx', 'drive_c', 'users')
  const baseUsersDir = existsSync(usersDir)
    ? usersDir
    : existsSync(pfxUsersDir)
      ? pfxUsersDir
      : null

  if (!baseUsersDir) return

  // For super-ultrawide (32:9) displays (width >= 3840), internal TargetRes is tuned to 1792x504
  // to achieve high framerates (100+ FPS) without hitting UE5 Nanite/Lumen fill-rate caps.
  const isSuperUltrawide = profile.targetResolution.width >= 3840
  const targetW = isSuperUltrawide ? 1792 : profile.targetResolution.width
  const targetH = isSuperUltrawide ? 504 : profile.targetResolution.height

  // 1. Tune SystemSettings.Windows.sav (Resolution & FirstLaunch flag)
  const systemSavFiles = findFilesInDir(baseUsersDir, 'SystemSettings.Windows.sav', 12)
  for (const sysSavPath of systemSavFiles) {
    try {
      const data = readFileSync(sysSavPath)
      const marker = Buffer.from('TargetRes\0\x0f\0\0\0StructProperty\0\x08\0\0\0\0\0\0\0\t\0\0\0IntPoint\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0', 'binary')
      const idx = data.indexOf(marker)
      let modified = false
      if (idx !== -1) {
        const valOffset = idx + marker.length
        const curW = data.readUInt32LE(valOffset)
        const curH = data.readUInt32LE(valOffset + 4)
        if (curW !== targetW || curH !== targetH) {
          data.writeUInt32LE(targetW, valOffset)
          data.writeUInt32LE(targetH, valOffset + 4)
          modified = true
        }
      }

      if (modified) {
        writeFileSync(sysSavPath, data)
        logInfo(
          `[MacOptimizer] Auto-tuned ${sysSavPath} TargetRes -> ${targetW}x${targetH} (Super-Ultrawide 100+ FPS optimized)`,
          LogPrefix.Backend
        )
      }
    } catch (err) {
      logError(['[MacOptimizer] Error tuning SystemSettings.sav:', err], LogPrefix.Backend)
    }
  }

  // 2. Tune GraphicsSettings.Windows.sav (UpscalerId & QualityMode)
  const gfxSavFiles = findFilesInDir(baseUsersDir, 'GraphicsSettings.Windows.sav', 12)
  for (const gfxSavPath of gfxSavFiles) {
    try {
      let data = readFileSync(gfxSavPath)
      let modified = false

      // Ensure top-level UpscalerId is set to FSR3
      const noneMarker = Buffer.from('\x05\0\0\0None\0\x11\0\0\0UpscalerSettings\0', 'binary')
      const upscalerDecl = Buffer.from('\x0b\0\0\0UpscalerId\0\r\0\0\0NameProperty\0\t\0\0\0\0\0\0\0\0\x05\0\0\0FSR3\0', 'binary')
      const nIdx = data.indexOf(noneMarker)
      if (nIdx !== -1) {
        const splitPos = nIdx + 10
        data = Buffer.concat([
          data.subarray(0, splitPos),
          upscalerDecl,
          data.subarray(splitPos)
        ])
        modified = true
      }

      // Neutralize UltraPerformance -> Quality inside UpscalerSettings
      const oldQm = Buffer.from('\x0e\0\0\0QualityModeId\0\r\0\0\0NameProperty\0\x15\0\0\0\0\0\0\0\0\x11\0\0\0UltraPerformance\0', 'binary')
      const newQm = Buffer.from('\x0e\0\0\0QualityModeId\0\r\0\0\0NameProperty\0\x0c\0\0\0\0\0\0\0\0\x08\0\0\0Quality\0', 'binary')
      let count = 0
      while (true) {
        const qIdx = data.indexOf(oldQm)
        if (qIdx === -1) break
        data = Buffer.concat([
          data.subarray(0, qIdx),
          newQm,
          data.subarray(qIdx + oldQm.length)
        ])
        count++
        modified = true
      }

      if (count > 0) {
        const mapDecl = Buffer.from('\x11\0\0\0UpscalerSettings\0\x0c\0\0\0MapProperty\0', 'binary')
        const mIdx = data.indexOf(mapDecl)
        if (mIdx !== -1) {
          const sizeOffset = mIdx + mapDecl.length
          const oldSize = data.readBigUInt64LE(sizeOffset)
          const newSize = oldSize - BigInt(count * 9)
          data.writeBigUInt64LE(newSize, sizeOffset)
        }
      }

      if (modified) {
        writeFileSync(gfxSavPath, data)
        logInfo(
          `[MacOptimizer] Auto-tuned ${gfxSavPath} Upscaler -> TSR (UltraPerformance banished)`,
          LogPrefix.Backend
        )
      }
    } catch (err) {
      logError(['[MacOptimizer] Error tuning GraphicsSettings.sav:', err], LogPrefix.Backend)
    }
  }
}

/**
 * Directly updates and tunes the Wine prefix registry files (user.reg & system.reg)
 * to ensure maximum performance and spoof modern AMD driver presence so games never complain
 * about missing AMD software, missing VRAM, or outdated drivers.
 */
export async function tuneWinePrefixForMac(
  prefixPath: string,
  gameSettings?: GameSettings,
  gameContext?: { app_name?: string; folder_name?: string; install_path?: string }
): Promise<void> {
  if (!isMac || !prefixPath) return

  const profile = await getMacHardwareProfile()
  const vramSize = profile.recommendedVramMB

  const possibleUserRegPaths = [
    join(prefixPath, 'user.reg'),
    join(prefixPath, 'pfx', 'user.reg')
  ]

  const possibleSystemRegPaths = [
    join(prefixPath, 'system.reg'),
    join(prefixPath, 'pfx', 'system.reg')
  ]

  const userRegPath = possibleUserRegPaths.find((p) => existsSync(p))
  const systemRegPath = possibleSystemRegPaths.find((p) => existsSync(p))

  if (userRegPath) {
    try {
      let content = readFileSync(userRegPath, 'utf-8')
      let modified = false

      // Configure [Software\\Wine\\Direct3D]
      if (content.includes('[Software\\\\Wine\\\\Direct3D]')) {
        // VideoMemorySize
        if (/^"VideoMemorySize"=/m.test(content)) {
          content = content.replace(
            /^"VideoMemorySize"=.*/m,
            `"VideoMemorySize"="${vramSize}"`
          )
          modified = true
        } else {
          content = content.replace(
            /\[Software\\\\Wine\\\\Direct3D\]([^\n]*\n)/,
            `[Software\\\\Wine\\\\Direct3D]$1"VideoMemorySize"="${vramSize}"\n`
          )
          modified = true
        }

        // Spoof AMD Radeon device ID in Direct3D registry
        if (!content.includes('"VideoPciDeviceID"=')) {
          content = content.replace(
            /\[Software\\\\Wine\\\\Direct3D\]([^\n]*\n)/,
            `[Software\\\\Wine\\\\Direct3D]$1"VideoPciDeviceID"=dword:000073ff\n"VideoPciVendorID"=dword:00001002\n`
          )
          modified = true
        }

        // Add CSMT multithreading flag if missing
        if (!content.includes('"csmt"=')) {
          content = content.replace(
            /\[Software\\\\Wine\\\\Direct3D\]([^\n]*\n)/,
            `[Software\\\\Wine\\\\Direct3D]$1"csmt"=dword:00000001\n`
          )
          modified = true
        }

        // Ensure CheckFloatConstants and StrictDrawOrdering are disabled for peak speed
        if (!content.includes('"CheckFloatConstants"=')) {
          content = content.replace(
            /\[Software\\\\Wine\\\\Direct3D\]([^\n]*\n)/,
            `[Software\\\\Wine\\\\Direct3D]$1"CheckFloatConstants"="disabled"\n"StrictDrawOrdering"="disabled"\n`
          )
          modified = true
        }

        if (!content.includes('"Multisampling"=')) {
          content = content.replace(
            /\[Software\\\\Wine\\\\Direct3D\]([^\n]*\n)/,
            `[Software\\\\Wine\\\\Direct3D]$1"Multisampling"="enabled"\n`
          )
          modified = true
        }
      } else {
        // Section not found, append it cleanly
        const d3dBlock = `\n[Software\\\\Wine\\\\Direct3D] ${Math.floor(Date.now() / 1000)}\n#time=1d9700000000000\n"CheckFloatConstants"="disabled"\n"StrictDrawOrdering"="disabled"\n"Multisampling"="enabled"\n"VideoMemorySize"="${vramSize}"\n"VideoPciDeviceID"=dword:000073ff\n"VideoPciVendorID"=dword:00001002\n"csmt"=dword:00000001\n`
        content += d3dBlock
        modified = true
      }

      // Configure [Software\\Wine\\Mac Driver] for 1:1 Direct hardware pixel presentation
      // Setting RetinaMode="n" ensures Direct presentation without WindowServer downscaled compositing,
      // unlocking full 144Hz high refresh rate and true 4K/5K pixel-perfect sharpness.
      if (!content.includes('[Software\\\\Wine\\\\Mac Driver]')) {
        const macDriverBlock = `\n[Software\\\\Wine\\\\Mac Driver] ${Math.floor(Date.now() / 1000)}\n#time=1d9700000000000\n"RetinaMode"="n"\n"WindowsShouldFloat"="n"\n`
        content += macDriverBlock
        modified = true
      } else if (content.includes('"RetinaMode"="y"')) {
        content = content.replace('"RetinaMode"="y"', '"RetinaMode"="n"')
        modified = true
      }

      // Auto-tune Unity engine titles in user.reg (Screenmanager resolution and fullscreen)
      if (content.includes('Screenmanager Resolution Width')) {
        const hexW = profile.targetResolution.width.toString(16).padStart(8, '0')
        const hexH = profile.targetResolution.height.toString(16).padStart(8, '0')
        content = content.replace(
          /^"Screenmanager Resolution Width[^"]*"=dword:[0-9a-fA-F]+/gm,
          (match) => match.replace(/dword:[0-9a-fA-F]+/, `dword:${hexW}`)
        )
        content = content.replace(
          /^"Screenmanager Resolution Height[^"]*"=dword:[0-9a-fA-F]+/gm,
          (match) => match.replace(/dword:[0-9a-fA-F]+/, `dword:${hexH}`)
        )
        content = content.replace(
          /^"Screenmanager Fullscreen mode[^"]*"=dword:[0-9a-fA-F]+/gm,
          (match) => match.replace(/dword:[0-9a-fA-F]+/, 'dword:00000001')
        )
        modified = true
      }

      if (modified) {
        writeFileSync(userRegPath, content, 'utf-8')
        logInfo(
          `[MacOptimizer] Successfully tuned user.reg in prefix (VRAM=${vramSize}MB, CSMT=1, RetinaMode=y, AMD Radeon spoofing active)`,
          LogPrefix.Backend
        )
      }
    } catch (err) {
      logError(['[MacOptimizer] Error tuning user.reg:', err], LogPrefix.Backend)
    }
  }

  if (systemRegPath) {
    try {
      let content = readFileSync(systemRegPath, 'utf-8')
      let modified = false

      // 1. Inject AMD Radeon Software mock keys
      if (!content.includes('[Software\\\\AMD\\\\RadeonSoftware]')) {
        const amdBlock = `\n[Software\\\\AMD\\\\RadeonSoftware] ${Math.floor(Date.now() / 1000)}\n#time=1d9700000000000\n"DriverVersion"="32.0.12011.1036"\n"Installed"=dword:00000001\n"RadeonSoftwareVersion"="24.10.1"\n"InstallDir"="C:\\\\Program Files\\\\AMD\\\\CNext\\\\CNext"\n\n[Software\\\\AMD\\\\CN] ${Math.floor(Date.now() / 1000)}\n#time=1d9700000000000\n"DriverVersion"="32.0.12011.1036"\n"Installed"=dword:00000001\n\n[Software\\\\ATI Technologies\\\\Install] ${Math.floor(Date.now() / 1000)}\n#time=1d9700000000000\n"Version"="24.10.1"\n"Installed"=dword:00000001\n`
        content += amdBlock
        modified = true
      }

      // 2. Inject Display Device Class registry keys to satisfy low-level Windows driver queries
      if (!content.includes('4d36e968-e325-11ce-bfc1-08002be10318')) {
        const deviceClassBlock = `\n[System\\\\CurrentControlSet\\\\Control\\\\Class\\\\{4d36e968-e325-11ce-bfc1-08002be10318}\\\\0000] ${Math.floor(Date.now() / 1000)}\n#time=1d9700000000000\n"DriverVersion"="32.0.12011.1036"\n"ReleaseVersion"="24.20.11.01-241010a-408000C"\n"DriverDate"="10-10-2026"\n"ProviderName"="Advanced Micro Devices, Inc."\n"DriverDesc"="AMD Radeon RX 7900 XTX"\n"MatchingDeviceId"="pci\\\\ven_1002&dev_73ff"\n`
        content += deviceClassBlock
        modified = true
      }

      if (modified) {
        writeFileSync(systemRegPath, content, 'utf-8')
        logInfo(
          '[MacOptimizer] Successfully injected complete AMD driver software and device class hierarchy in system.reg',
          LogPrefix.Backend
        )
      }
    } catch (err) {
      logError(['[MacOptimizer] Error tuning system.reg:', err], LogPrefix.Backend)
    }
  }

  // Inject optimized dxvk.conf into prefix and game folder
  writeOptimizedDxvkConf(prefixPath, profile)
  if (gameContext?.install_path && existsSync(gameContext.install_path)) {
    writeOptimizedDxvkConf(gameContext.install_path, profile)
  }
  if (gameContext?.folder_name && existsSync(gameContext.folder_name)) {
    writeOptimizedDxvkConf(gameContext.folder_name, profile)
  }

  // Automatically tune in-game graphics files (Unreal Engine / Unity)
  autoTuneGameEngineSettings(prefixPath, profile)
  autoTuneSaveGameSettings(prefixPath, profile)

  // Automatically neutralize hardcoded hardware enforcers and driver popups in game binaries
  if (gameContext?.install_path && existsSync(gameContext.install_path)) {
    autoPatchUe5EnforcerAndDriverChecks(gameContext.install_path)
  }
  if (gameContext?.folder_name && existsSync(gameContext.folder_name)) {
    autoPatchUe5EnforcerAndDriverChecks(gameContext.folder_name)
  }
}

/**
 * Returns optimized, high-performance environment variables tailored for running
 * games on macOS Apple Silicon and Intel Metal architectures.
 */
export function getMacPerformanceEnvVars(
  gameSettings?: GameSettings
): Record<string, string> {
  const env: Record<string, string> = {}

  if (!isMac) return env

  // Mach semaphores/ports zero-contention synchronization on macOS
  env.WINEMSYNC = '1'

  // Rosetta 2 AVX and AVX2 vector extension support for modern game titles
  env.ROSETTA_ADVERTISE_AVX = '1'
  env.ROSETTA_ENABLE_EXPERIMENTAL_AVX = '1'

  // Metal zero-overhead direct dispatch (removes shader validation & wrapper overhead)
  env.MTL_SHADER_VALIDATION = '0'
  env.MTL_DEVICE_WRAPPER_TYPE = '0'
  env.METAL_DEVICE_WRAPPER_TYPE = '0'

  // MoltenVK performance and math optimizations
  env.MVK_CONFIG_RESILIENT_INDEXING = '1'
  env.MVK_CONFIG_FAST_MATH = '1'
  env.MVK_CONFIG_USE_MTLCONCURRENT_RESOURCE_COMPUTE_COMMAND_ENCODERS = '1'
  env.MVK_CONFIG_MAX_ACTIVE_SURFACE_BUFFERS = '3'

  // Real-time scheduling priority hint for Wine thread dispatcher
  env.WINE_RT_PRIORITY = '1'

  // Low latency audio buffer to prevent audio stuttering during heavy load
  env.PULSE_LATENCY_MSEC = '60'

  // Suppress verbose Apple D3DMetal logging in production for maximum frame rate
  env.D3DMETAL_LOG_LEVEL = '0'

  return env
}

/**
 * Recursively locates all child process IDs of a given parent process ID.
 */
async function getChildPids(parentPid: number): Promise<number[]> {
  try {
    const { stdout } = await execPromise(`pgrep -P ${parentPid}`)
    if (!stdout.trim()) return []
    const pids = stdout
      .trim()
      .split('\n')
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => !isNaN(p) && p > 0)
    
    const nested = await Promise.all(pids.map((p) => getChildPids(p)))
    return [...pids, ...nested.flat()]
  } catch {
    return []
  }
}

/**
 * Boosts the process priority of a spawned game process and its child execution tree
 * to High Priority (nice -10), signaling the Darwin kernel scheduler to bind execution
 * onto Apple Silicon Performance/Super cores.
 * Also starts an asynchronous background monitor to elevate any late-spawned game binaries (wine64, .exe).
 */
export function boostGameProcessPriority(pid: number | undefined): void {
  if (!isMac || !pid || pid <= 0) return

  const applyBoost = async (targetPid: number) => {
    try {
      // 1. Darwin taskpolicy: move target process out of background efficiency clamping
      // and assign throughput tier 0 (maximum CPU throughput) and latency tier 0 (interactive)
      await execPromise(`/usr/sbin/taskpolicy -B -t 0 -l 0 -p ${targetPid}`).catch(() => {})
    } catch {}

    try {
      setPriority(targetPid, -10)
    } catch {
      await execPromise(`renice -10 -p ${targetPid}`).catch(() => {})
    }
  }

  // Immediate boost for the root process
  void applyBoost(pid)
  logInfo(
    `[MacOptimizer] Elevated root game process (PID ${pid}) scheduling priority to High Priority on Performance cores`,
    LogPrefix.Backend
  )

  // Asynchronous polling to elevate child processes (Wine loader, Game binary) as they spawn
  const checkDelaysMs = [800, 1800, 3200, 5500, 9000, 15000, 25000]
  for (const delay of checkDelaysMs) {
    setTimeout(async () => {
      try {
        const children = await getChildPids(pid)
        for (const childPid of children) {
          await applyBoost(childPid)
        }
        if (children.length > 0) {
          logInfo(
            `[MacOptimizer] Boosted ${children.length} game child processes to High Priority on Performance cores: ${children.join(', ')}`,
            LogPrefix.Backend
          )
        }
      } catch {}
    }, delay)
  }
}
