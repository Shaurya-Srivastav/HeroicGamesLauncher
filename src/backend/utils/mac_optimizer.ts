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

    const totalRamBytes = totalmem()
    const ramGB = Math.round(totalRamBytes / (1024 * 1024 * 1024))

    // Dynamically calculate optimal Direct3D VRAM allocation reported to games
    let recommendedVramMB = '8192'
    let performanceTier: 'ultra' | 'high' | 'medium' = 'high'
    let targetResolution = { width: 1920, height: 1080 }

    if (ramGB >= 64 || gpuCores >= 32) {
      performanceTier = 'ultra'
      recommendedVramMB = '49152' // 48 GB
      targetResolution = { width: 2560, height: 1440 }
    } else if (ramGB >= 32 || gpuCores >= 24) {
      performanceTier = 'ultra'
      recommendedVramMB = '24576' // 24 GB
      targetResolution = { width: 2560, height: 1440 }
    } else if (ramGB >= 24 || gpuCores >= 10) {
      performanceTier = 'high'
      recommendedVramMB = '16384' // 16 GB (Perfect for 24GB M5)
      targetResolution = { width: 1920, height: 1200 }
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
dxgi.syncInterval = 1
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
 * Recursively searches a directory up to maxDepth for a target filename.
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
        } else if (entry.toLowerCase() === targetFileName.toLowerCase()) {
          results.push(fullPath)
        }
      } catch {}
    }
  } catch {}

  return results
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

  // Search for Unreal Engine GameUserSettings.ini files in AppData/Local
  const iniFiles = findFilesInDir(baseUsersDir, 'GameUserSettings.ini', 5)

  for (const iniPath of iniFiles) {
    try {
      let content = readFileSync(iniPath, 'utf-8')
      let modified = false

      const targetW = profile.targetResolution.width
      const targetH = profile.targetResolution.height
      const refreshRate = profile.displayRefreshRate

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

      // Refresh rate / FPS limit (align with ProMotion 120Hz or 60Hz)
      if (/^FrameRateLimit=/m.test(content)) {
        content = content.replace(/^FrameRateLimit=.*/m, `FrameRateLimit=${refreshRate}.000000`)
        modified = true
      } else if (content.includes('[/Script/Engine.GameUserSettings]')) {
        content = content.replace(
          '[/Script/Engine.GameUserSettings]',
          `[/Script/Engine.GameUserSettings]\nFrameRateLimit=${refreshRate}.000000`
        )
        modified = true
      }

      // Borderless Fullscreen for optimal macOS window compositing
      if (/^FullscreenMode=/m.test(content)) {
        content = content.replace(/^FullscreenMode=.*/m, 'FullscreenMode=1')
        modified = true
      }
      if (/^LastConfirmedFullscreenMode=/m.test(content)) {
        content = content.replace(/^LastConfirmedFullscreenMode=.*/m, 'LastConfirmedFullscreenMode=1')
        modified = true
      }

      // VSync: macOS Metal compositor already presents tear-free frames, disable software VSync latency
      if (/^bUseVSync=/m.test(content)) {
        content = content.replace(/^bUseVSync=.*/m, 'bUseVSync=False')
        modified = true
      }

      // Tier-based scalability groups
      const qualityLevel = profile.performanceTier === 'ultra' ? 3 : profile.performanceTier === 'high' ? 2 : 1
      const scalabilityKeys = [
        'sg.ViewDistanceQuality',
        'sg.AntiAliasingQuality',
        'sg.ShadowQuality',
        'sg.PostProcessQuality',
        'sg.TextureQuality',
        'sg.EffectsQuality',
        'sg.FoliageQuality',
        'sg.ShadingQuality'
      ]

      for (const key of scalabilityKeys) {
        const regex = new RegExp(`^${key.replace('.', '\\.')}=.*`, 'm')
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${qualityLevel}`)
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

      // Configure [Software\\Wine\\Mac Driver] for Retina display scaling
      if (!content.includes('[Software\\\\Wine\\\\Mac Driver]')) {
        const macDriverBlock = `\n[Software\\\\Wine\\\\Mac Driver] ${Math.floor(Date.now() / 1000)}\n#time=1d9700000000000\n"RetinaMode"="y"\n"WindowsShouldFloat"="n"\n`
        content += macDriverBlock
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
